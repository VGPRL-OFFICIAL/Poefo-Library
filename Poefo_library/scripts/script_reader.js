const pdfjsLib = window['pdfjs-dist/build/pdf'];
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let pdfDoc = null, pageFlip = null;
let isDrawingMode = false, isDrawing = false;
let readerSessionSeconds = 0;
let readerTotalStoredSeconds = 0;
let readerTimerInterval = null;
let readerBookId = null;
let readerBookProgress = null;
let readerCurrentPage = 1;
let readerViewMode = getInitialReaderViewMode();
let isReloadingForViewMode = false;
let pendingReaderPage = null;
let toolbarHideTimeout = null;
let pageWrappers = [];
const renderedPages = new Map();
const pageRenderPromises = new Map();
const pageDrawings = new Map();
let pageRenderRequestId = 0;

// Variáveis de Controle de Zoom e Movimentação (Pan)
let scale = 1;
let posX = 0, posY = 0;
let lastPosX = 0, lastPosY = 0;
let isDragging = false;
let lastDist = 0;

function getInitialReaderViewMode() {
    try {
        const reloadMode = sessionStorage.getItem('poefo_reader_reload_mode');
        if (reloadMode === 'single' || reloadMode === 'double' || reloadMode === 'scroll') {
            sessionStorage.removeItem('poefo_reader_reload_mode');
            return reloadMode;
        }
    } catch (error) {
        console.warn('Não foi possível carregar o modo de leitura após recarregar:', error);
    }
    try {
        const savedMode = localStorage.getItem('poefo_reader_view_mode');
        if (savedMode === 'single' || savedMode === 'double' || savedMode === 'scroll') return savedMode;
    } catch (error) {
        console.warn('Não foi possível carregar a preferência de visualização:', error);
    }
    return window.innerWidth < 768 ? 'single' : 'double';
}

async function initReader() {
    hideReaderToolbar();
    const url = sessionStorage.getItem('readerUrl');
    if (!url) {
        showReaderError();
        return;
    }
    readerBookId = sessionStorage.getItem('readerBookId');

    try {
        pdfDoc = await pdfjsLib.getDocument({
            url,
            disableAutoFetch: true,
            rangeChunkSize: 524288
        }).promise;
        document.getElementById('page-count').textContent = pdfDoc.numPages;
        if (readerBookId && typeof loadUserBookProgress === 'function') {
            readerBookProgress = await loadUserBookProgress(readerBookId);
            readerCurrentPage = Math.min(
                Math.max(1, Number(readerBookProgress?.pagina) || 1),
                pdfDoc.numPages
            );
            document.getElementById('page-num').textContent = readerCurrentPage;
        }
        restoreReaderPageAfterModeChange(pdfDoc.numPages);
        createPageSlots();
        setupPageFlip();
        await renderPagesAround(readerCurrentPage);
        if (readerViewMode === 'scroll') {
            scrollToReaderPage(readerCurrentPage, 'auto');
        }
        updatePageIndicator();
        if (typeof loadUserProgressSummary === 'function') {
            loadUserProgressSummary()
                .then(data => {
                    readerTotalStoredSeconds = data ? data.totalSeconds : 0;
                    const display = document.getElementById('reader-time-value');
                    if (display) display.innerText = formatDuration(readerTotalStoredSeconds);
                })
                .catch(() => loadUserProgressFallback());
        }
        startReaderTimer();
        hideReaderToolbar();
        
        document.getElementById('loading-overlay').style.display = 'none';
        document.getElementById('pdf-book').style.visibility = 'visible';
    } catch (e) {
        console.error('PDF.js não conseguiu abrir o link:', e);
        showReaderError();
    }
}

function showReaderError() {
    const overlay = document.getElementById('loading-overlay');
    overlay.innerHTML = '<p class="reader-error">Não foi possível visualizar este arquivo. Abra o arquivo original para continuar.</p>';
    overlay.style.display = 'flex';
}

function restoreReaderPageAfterModeChange(pageCount) {
    try {
        const savedState = sessionStorage.getItem('poefo_reader_reload_page');
        if (!savedState) return;
        sessionStorage.removeItem('poefo_reader_reload_page');

        const { bookId, page } = JSON.parse(savedState);
        if (bookId !== readerBookId || !Number.isInteger(page)) return;
        readerCurrentPage = Math.min(Math.max(1, page), pageCount);
        document.getElementById('page-num').textContent = readerCurrentPage;
    } catch (error) {
        console.warn('Não foi possível restaurar a página após alterar o modo de leitura:', error);
    }
}

function createPageSlots() {
    const container = document.getElementById('pdf-book');
    container.innerHTML = '';
    pageWrappers = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
        const pageDiv = document.createElement('div');
        pageDiv.className = 'page-wrapper';
        pageWrappers.push(pageDiv);
        container.appendChild(pageDiv);
    }
}

async function renderPage(pageNumber) {
    const existingPage = renderedPages.get(pageNumber);
    if (existingPage) {
        await existingPage.promise;
        return;
    }

    const pendingRender = pageRenderPromises.get(pageNumber);
    if (pendingRender) {
        await pendingRender;
        return;
    }

    const pageWrapper = pageWrappers[pageNumber - 1];
    const canvas = document.createElement('canvas');
    canvas.className = 'page-canvas';
    const drawCanvas = document.createElement('canvas');
    drawCanvas.className = 'draw-canvas';
    const renderedPage = { canvas, drawCanvas, promise: null, hasDrawing: false };
    pageWrapper.replaceChildren(canvas, drawCanvas);
    renderedPages.set(pageNumber, renderedPage);

    renderedPage.promise = (async () => {
        const page = await pdfDoc.getPage(pageNumber);
        const baseViewport = page.getViewport({ scale: 1 });
        const maxCanvasPixels = 2_000_000;
        const scale = Math.min(1.5, Math.sqrt(maxCanvasPixels / (baseViewport.width * baseViewport.height)));
        const viewport = page.getViewport({ scale });
        const context = canvas.getContext('2d');
        const drawingContext = drawCanvas.getContext('2d');
        if (!context || !drawingContext) throw new Error(`Não foi possível criar o canvas da página ${pageNumber}.`);

        canvas.height = viewport.height;
        canvas.width = viewport.width;
        drawCanvas.height = canvas.height;
        drawCanvas.width = canvas.width;
        if (readerViewMode === 'scroll') {
            pageWrapper.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
        }

        await page.render({ canvasContext: context, viewport }).promise;
        page.cleanup();

        const drawing = pageDrawings.get(pageNumber);
        if (drawing) {
            const image = new Image();
            await new Promise((resolve, reject) => {
                image.onload = resolve;
                image.onerror = () => reject(new Error(`Não foi possível restaurar as anotações da página ${pageNumber}.`));
                image.src = drawing;
            });
            drawingContext.drawImage(image, 0, 0);
            pageDrawings.delete(pageNumber);
        }
        setupDrawing(drawCanvas, () => { renderedPage.hasDrawing = true; });
    })().catch(error => {
        if (renderedPages.get(pageNumber) === renderedPage) {
            renderedPages.delete(pageNumber);
            pageWrapper.replaceChildren();
        }
        throw error;
    }).finally(() => {
        pageRenderPromises.delete(pageNumber);
    });

    pageRenderPromises.set(pageNumber, renderedPage.promise);
    await renderedPage.promise;
}

async function renderPagesAround(pageNumber) {
    const requestId = ++pageRenderRequestId;
    const firstPage = Math.max(1, pageNumber - 1);
    const pagesAhead = readerViewMode === 'double' && pageNumber > 1 ? 3 : 2;
    const lastPage = Math.min(pdfDoc.numPages, pageNumber + pagesAhead);
    const pagesToRender = [];
    for (let page = firstPage; page <= lastPage; page++) {
        pagesToRender.push(renderPage(page));
    }
    await Promise.all(pagesToRender);
    if (requestId !== pageRenderRequestId) return;

    for (const [renderedPageNumber, renderedPage] of renderedPages) {
        if (renderedPageNumber >= firstPage && renderedPageNumber <= lastPage) continue;
        if (renderedPage.hasDrawing) {
            pageDrawings.set(renderedPageNumber, renderedPage.drawCanvas.toDataURL('image/png'));
        }
        pageWrappers[renderedPageNumber - 1].replaceChildren();
        renderedPages.delete(renderedPageNumber);
    }
}

function setupPageFlip() {
    if (readerViewMode === 'scroll') {
        applyReaderViewMode();
        return;
    }

    const bookEl = document.getElementById('pdf-book');
    
    pageFlip = new St.PageFlip(bookEl, {
        width: 550, height: 800,
        size: "stretch",
        minWidth: 160,
        maxWidth: 550,
        minHeight: 300,
        maxHeight: 800,
        showCover: true,
        useMouseEvents: !isDrawingMode,
        drawShadow: false, // Estética limpa (sem fundo branco/sombras na dobra)
        flippingTime: 800,
        usePortrait: readerViewMode === 'single',
        startPage: Math.max(0, readerCurrentPage - 1)
    });
    pageFlip.loadFromHTML(document.querySelectorAll('.page-wrapper'));
    applyReaderViewMode();
    pageFlip.on('flip', (e) => {
        pendingReaderPage = e.data + 1;
        showReaderToolbar();
        if (pageFlip.getState() === 'read') completePageTurn();
    });
    pageFlip.on('changeState', (e) => {
        const modeSelect = document.getElementById('page-view-mode');
        if (modeSelect) {
            modeSelect.disabled = e.data !== 'read';
        }
        if (e.data === 'read') completePageTurn();
    });
}

function applyReaderViewMode() {
    const bookEl = document.getElementById('pdf-book');
    const zoomArea = document.getElementById('zoom-container');
    const isSinglePage = readerViewMode === 'single';
    const isScrollMode = readerViewMode === 'scroll';

    bookEl.classList.toggle('reader-scroll-mode', isScrollMode);
    zoomArea.classList.toggle('reader-scroll-container', isScrollMode);
    zoomArea.style.overflowX = isScrollMode && scale > 1 ? 'auto' : 'hidden';
    zoomArea.style.touchAction = isScrollMode ? (scale > 1 ? 'pan-x pan-y' : 'pan-y') : 'none';

    bookEl.style.maxWidth = isSinglePage ? '540px' : isScrollMode ? 'none' : '1100px';
    bookEl.style.minWidth = isSinglePage ? '275px' : isScrollMode ? '0' : '320px';
    bookEl.style.width = isScrollMode ? `${Math.min(640, Math.max(1, zoomArea.clientWidth - 24)) * scale}px` : '';
    bookEl.style.transform = isScrollMode ? 'none' : `translate(${posX}px, ${posY}px) scale(${scale})`;

    if (pageFlip) {
        pageFlip.getSettings().usePortrait = isSinglePage;
        pageFlip.getSettings().minWidth = isSinglePage ? 275 : 160;
        pageFlip.update();
    }

    const modeSelect = document.getElementById('page-view-mode');
    if (modeSelect) {
        modeSelect.value = readerViewMode;
        modeSelect.disabled = false;
    }
    updatePageIndicator();
}

function completePageTurn() {
    if (pendingReaderPage === null) return;

    readerCurrentPage = pendingReaderPage;
    pendingReaderPage = null;
    updatePageIndicator();
    renderPagesAround(readerCurrentPage).catch(error => {
        console.error('Não foi possível renderizar as páginas do PDF:', error);
        showReaderError();
    });
    saveCurrentBookProgress();
}

function updatePageIndicator() {
    const pageNumber = document.getElementById('page-num');
    if (!pageNumber) return;

    const isLandscapeSpread = readerViewMode === 'double'
        && pageFlip
        && pageFlip.getOrientation() === 'landscape';
    const isSingleCover = readerCurrentPage === 1 || readerCurrentPage === pdfDoc?.numPages;
    if (isLandscapeSpread && !isSingleCover) {
        pageNumber.textContent = `${readerCurrentPage}-${Math.min(readerCurrentPage + 1, pdfDoc.numPages)}`;
    } else {
        pageNumber.textContent = readerCurrentPage;
    }
}

function changeReaderViewMode(nextMode) {
    if (isReloadingForViewMode || !['single', 'double', 'scroll'].includes(nextMode) || nextMode === readerViewMode) return;
    showReaderToolbar();
    readerViewMode = nextMode;
    try {
        localStorage.setItem('poefo_reader_view_mode', readerViewMode);
    } catch (error) {
        console.warn('Não foi possível salvar a preferência de visualização:', error);
    }
    isReloadingForViewMode = true;
    const modeSelect = document.getElementById('page-view-mode');
    if (modeSelect) modeSelect.disabled = true;
    try {
        sessionStorage.setItem('poefo_reader_reload_mode', readerViewMode);
        sessionStorage.setItem('poefo_reader_reload_page', JSON.stringify({
            bookId: readerBookId,
            page: pendingReaderPage ?? readerCurrentPage
        }));
    } catch (error) {
        console.warn('Não foi possível salvar a página atual antes de recarregar o leitor:', error);
    }
    window.location.reload();
}

document.getElementById('page-view-mode').addEventListener('change', (event) => {
    changeReaderViewMode(event.target.value);
});

// Aqui eu configuro a barra de filtros.
document.getElementById('filter-btn').onclick = () => {
    document.getElementById('filter-bar').classList.toggle('active');
};

function applyFilter(filter) {
    const book = document.getElementById('pdf-book');
    ['sepia', 'dark', 'warm', 'grayscale', 'blue', 'green', 'contrast', 'cinema']
        .forEach(filterClass => book.classList.toggle(filterClass, filterClass === filter));
}

// Aqui eu controlo o desenho e o bloqueio da página.
document.getElementById('pencil-tool').onclick = function() {
    isDrawingMode = !isDrawingMode;
    this.classList.toggle('active');
    
    // Reseta zoom e posição ao entrar no modo desenho para evitar bugs de coordenadas
    resetZoom();

    if (pageFlip && typeof pageFlip.updateConfig === 'function') {
        pageFlip.updateConfig({
            useMouseEvents: !isDrawingMode,
            clickEventForward: !isDrawingMode
        });
    }

    document.querySelectorAll('.draw-canvas').forEach(c => {
        c.style.pointerEvents = isDrawingMode ? 'all' : 'none';
    });
};

async function startReaderTimer() {
    if (readerTimerInterval) return;
    readerTimerInterval = setInterval(async () => {
        readerSessionSeconds += 1;
        if (readerSessionSeconds >= 60) {
            const secondsToAdd = 60;
            readerSessionSeconds -= 60;
            await persistReadingTime(secondsToAdd);
        }
        const display = document.getElementById('reader-time-value');
        if (display) display.innerText = formatDuration(readerTotalStoredSeconds + readerSessionSeconds);
    }, 1000);
}

async function stopReaderTimer() {
    if (readerTimerInterval) {
        clearInterval(readerTimerInterval);
        readerTimerInterval = null;
    }
    if (readerSessionSeconds > 0) {
        const leftover = readerSessionSeconds;
        readerSessionSeconds = 0;
        await persistReadingTime(leftover);
    }
    await saveCurrentBookProgress();
}

async function persistReadingTime(seconds) {
    const tasks = [];
    if (typeof addUserReadingSeconds === 'function' && typeof getCurrentUserId === 'function' && getCurrentUserId()) {
        tasks.push(addUserReadingSeconds(seconds).catch(() => saveUserProgressLocalFallback(0, seconds)));
    } else {
        tasks.push(saveUserProgressLocalFallback(0, seconds));
    }
    if (readerBookId && typeof saveUserBookProgress === 'function') {
        tasks.push(saveUserBookProgress(readerBookId, readerCurrentPage, seconds, pdfDoc?.numPages));
    }
    await Promise.all(tasks);
}

async function saveCurrentBookProgress() {
    if (!readerBookId || typeof saveUserBookProgress !== 'function') return;
    await saveUserBookProgress(readerBookId, readerCurrentPage, 0, pdfDoc?.numPages);
}

function setupDrawing(canvas, onDraw = () => {}) {
    const ctx = canvas.getContext('2d');
    const getPos = (e) => {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return {
            x: (clientX - rect.left) * (canvas.width / rect.width),
            y: (clientY - rect.top) * (canvas.height / rect.height)
        };
    };

    canvas.addEventListener('mousedown', (e) => { if(!isDrawingMode) return; isDrawing = true; onDraw(); ctx.beginPath(); const p = getPos(e); ctx.moveTo(p.x, p.y); });
    canvas.addEventListener('mousemove', (e) => {
        if (!isDrawing || !isDrawingMode) return;
        const p = getPos(e);
        ctx.lineTo(p.x, p.y);
        ctx.strokeStyle = "red"; ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.stroke();
    });
    window.addEventListener('mouseup', () => isDrawing = false);
}

// --- SISTEMA DE ZOOM E MOVIMENTAÇÃO (PAN) ---

const zoomContainer = document.getElementById('zoom-container');
const bookEl = document.getElementById('pdf-book');

function updateTransform() {
    if (readerViewMode === 'scroll') {
        const baseWidth = Math.min(640, Math.max(1, zoomContainer.clientWidth - 24));
        bookEl.style.width = `${baseWidth * scale}px`;
        bookEl.style.maxWidth = 'none';
        bookEl.style.minWidth = '0';
        bookEl.style.transform = 'none';
        zoomContainer.style.overflowX = scale > 1 ? 'auto' : 'hidden';
        zoomContainer.style.touchAction = scale > 1 ? 'pan-x pan-y' : 'pan-y';
        return;
    }

    bookEl.style.transform = `translate(${posX}px, ${posY}px) scale(${scale})`;
    zoomContainer.style.overflowX = 'hidden';
    zoomContainer.style.touchAction = 'none';
}

function resetZoom() {
    scale = 1; posX = 0; posY = 0;
    updateTransform();
}

function setReaderScale(targetScale) {
    scale = Math.min(Math.max(0.5, Number(targetScale) || 1), 4);
    if (scale <= 1) { posX = 0; posY = 0; }
    updateTransform();
}

// Mouse Wheel Zoom (Ctrl + Scroll)
zoomContainer.addEventListener('wheel', (e) => {
    showReaderToolbar();
    if (e.ctrlKey) {
        e.preventDefault();
        const delta = e.deltaY * -0.001;
        setReaderScale(scale + delta);
    }
}, { passive: false });

// Início do Arrastre (Mouse e Touch)
const startDragging = (e) => {
    if (isDrawingMode || scale <= 1 || readerViewMode === 'scroll' && e.target.closest('.page-wrapper')) return;
    isDragging = true;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    lastPosX = clientX - posX;
    lastPosY = clientY - posY;
};

const doDragging = (e) => {
    if (!isDragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    posX = clientX - lastPosX;
    posY = clientY - lastPosY;
    updateTransform();
};

const stopDragging = () => { isDragging = false; };

// Pinch Zoom (Pinça no Touch)
zoomContainer.addEventListener('touchstart', (e) => {
    showReaderToolbar();
    if (e.touches.length === 2) {
        lastDist = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY);
    } else if (readerViewMode !== 'scroll') {
        startDragging(e);
    }
});

zoomContainer.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
        e.preventDefault();
        const dist = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY);
        setReaderScale(scale * (dist / lastDist));
        lastDist = dist;
    } else if (readerViewMode !== 'scroll') {
        doDragging(e);
    }
}, { passive: false });

zoomContainer.addEventListener('touchend', stopDragging);
zoomContainer.addEventListener('mousedown', startDragging);
zoomContainer.addEventListener('pointerdown', showReaderToolbar);
zoomContainer.addEventListener('pointermove', showReaderToolbar);
window.addEventListener('mousemove', doDragging);
window.addEventListener('mouseup', stopDragging);
window.addEventListener('beforeunload', stopReaderTimer);
window.addEventListener('pagehide', stopReaderTimer);

function moveReaderPage(direction) {
    showReaderToolbar();
    if (readerViewMode === 'scroll') {
        const targetPage = Math.min(Math.max(1, readerCurrentPage + direction), pdfDoc ? pdfDoc.numPages : 1);
        if (targetPage === readerCurrentPage) return;
        scrollToReaderPage(targetPage, 'smooth');
        return;
    }

    if (!isDrawingMode && pageFlip) {
        if (direction < 0) pageFlip.flipPrev();
        else pageFlip.flipNext();
    }
}

document.getElementById('prev-page').onclick = () => moveReaderPage(-1);
document.getElementById('next-page').onclick = () => moveReaderPage(1);

document.getElementById('zoom-in').addEventListener('click', () => {
    showReaderToolbar();
    setReaderScale(scale + 0.25);
});
document.getElementById('zoom-out').addEventListener('click', () => {
    showReaderToolbar();
    setReaderScale(scale - 0.25);
});

function scrollToReaderPage(pageNumber, behavior = 'smooth') {
    const wrapper = pageWrappers[pageNumber - 1];
    if (!wrapper) return;
    const containerTop = zoomContainer.getBoundingClientRect().top;
    const targetTop = wrapper.getBoundingClientRect().top - containerTop + zoomContainer.scrollTop;
    zoomContainer.scrollTo({ top: targetTop, behavior });
}

zoomContainer.addEventListener('scroll', () => {
    if (readerViewMode !== 'scroll' || !pageWrappers.length || !pdfDoc) return;
    showReaderToolbar();
    const targetY = zoomContainer.getBoundingClientRect().top + zoomContainer.clientHeight * 0.45;
    let activePage = readerCurrentPage;
    let nearestDistance = Infinity;
    for (let i = 0; i < pageWrappers.length; i += 1) {
        const rect = pageWrappers[i].getBoundingClientRect();
        const distance = Math.abs((rect.top + rect.bottom) / 2 - targetY);
        if (distance < nearestDistance) {
            nearestDistance = distance;
            activePage = i + 1;
        }
    }
    if (activePage !== readerCurrentPage) {
        readerCurrentPage = activePage;
        updatePageIndicator();
        saveCurrentBookProgress();
        renderPagesAround(readerCurrentPage).catch(error => {
            console.error('Não foi possível renderizar as páginas durante a rolagem:', error);
            showReaderError();
        });
    }
});

function showReaderToolbar() {
    const toolbar = document.querySelector('.reader-toolbar');
    if (!toolbar) return;
    toolbar.classList.add('is-visible');
    toolbar.setAttribute('aria-hidden', 'false');
    toolbar.inert = false;
    clearTimeout(toolbarHideTimeout);
    toolbarHideTimeout = window.setTimeout(hideReaderToolbar, 4000);
}

function hideReaderToolbar() {
    const toolbar = document.querySelector('.reader-toolbar');
    if (!toolbar) return;
    toolbar.classList.remove('is-visible');
    toolbar.setAttribute('aria-hidden', 'true');
    toolbar.inert = true;
}

const readerToolbar = document.querySelector('.reader-toolbar');
readerToolbar.addEventListener('pointerdown', showReaderToolbar);
readerToolbar.addEventListener('focusin', showReaderToolbar);
readerToolbar.addEventListener('click', showReaderToolbar);

initReader();