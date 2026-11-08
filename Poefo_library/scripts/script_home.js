// scripts/script_home.js

const LIVROS_API_URL = 'https://firebasestorage.googleapis.com/v0/b/captu-libraly.firebasestorage.app/o/livros_json%2Flivros.json?alt=media&token=3eaf739c-b9fc-45b7-ab15-800d9058655a';

let allBooksPoefo = [];

// Elementos DOM
let heroContainer, genreSectionsContainer, gridPoefo, gridDuckDog, genreFilters, searchInput, userAvatarElement, continueReadingContainer;

function initDOMElements() {
    heroContainer = document.getElementById('hero-highlight');
    genreSectionsContainer = document.getElementById('dynamic-genre-sections');
    gridPoefo = document.getElementById('all-books-grid');
    gridDuckDog = document.getElementById('google-books-grid');
    genreFilters = document.getElementById('genre-filters');
    searchInput = document.getElementById('main-search');
    userAvatarElement = document.getElementById('header-user-avatar');
    continueReadingContainer = document.getElementById('continue-reading-card');
}

// --- CONFIGURAÇÃO DOS CARDS DE REDIRECIONAMENTO POR CATEGORIA ---
// Eu edito esta lista para alterar os textos e as imagens entre categorias.
const REDIRECT_CARDS_DATA = {
    // Card Padrão da página de Games para a Primeira Categoria
    0: {
        tag: "NOVO DESAFIO",
        title: "Acesse os games e aumente seu ranking",
        desc: "Complete desafios literários, acumule pontos e veja sua evolução continuar salva no perfil.",
        btnText: "Abrir games",
        btnUrl: "/jogos",
        image: "../images/banner-games.svg"
    },
    // Estrutura do 2º Campo de Redirecionamento (Basta alterar os dados abaixo)
    1: {
        tag: "COMUNIDADE",
        title: "Participe das discussões no Feed",
        desc: "Veja o que outros leitores estão comentando e compartilhe suas opiniões.",
        btnText: "Ver Feed",
        btnUrl: "/feed",
        image: "../images/banner-feed.svg"
    },
    // Estrutura do 3º Campo de Redirecionamento (Basta alterar os dados abaixo)
    2: {
        tag: "PUBLICAÇÃO",
        title: "Escreva e publique seu próprio livro",
        desc: "Utilize nosso editor completo para criar novas histórias e compartilhar com a comunidade.",
        btnText: "Criar agora",
        btnUrl: "/criar",
        image: "../images/banner-criacao.svg"
    }
};

// --- CARREGAR PERFIL ---
async function loadUserProfile() {
    const cachedPic = sessionStorage.getItem('currentUserPic') || '../images/user_ic.png';
    if (userAvatarElement) userAvatarElement.src = cachedPic;

    const userData = localStorage.getItem('userLogado');
    if (userData) {
        try {
            const user = JSON.parse(userData);
            if (user.img && userAvatarElement) {
                userAvatarElement.src = user.img;
            }
        } catch (e) {
            console.error("Erro ao carregar perfil:", e);
        }
    }

    const userId = sessionStorage.getItem('currentUserId') || localStorage.getItem('currentUserId');
    if (!userId || typeof firebase === 'undefined' || !window.POEFO_FIREBASE_CONFIG) return;

    try {
        if (!firebase.apps.length) firebase.initializeApp(window.POEFO_FIREBASE_CONFIG);
        const snapshot = await firebase.database().ref(`usuarios/${userId}`).once('value');
        const profile = snapshot.val() || {};
        const profilePic = profile.foto_perfil || profile.img || cachedPic;
        if (userAvatarElement) userAvatarElement.src = profilePic;
        sessionStorage.setItem('currentUserPic', profilePic);
    } catch (error) {
        console.warn('Não foi possível carregar a foto de perfil:', error);
    }
}

// --- CARREGAR APLICAÇÃO ---
async function loadApp() {
    initDOMElements();
    loadUserProfile();
    setupFilterToggle();

    try {
        const res = await fetch(LIVROS_API_URL);
        if (!res.ok) throw new Error("Falha ao acessar API Poefo");
        
        allBooksPoefo = await res.json();
        
        if (allBooksPoefo && allBooksPoefo.length > 0) {
            const genres = [...new Set(allBooksPoefo.map(b => b.genero).filter(g => g))];
            
            renderFilters(genres);
            renderHero(allBooksPoefo[0]);
            listenForFeaturedBook(allBooksPoefo);
            await renderMostRecentReading(allBooksPoefo);
            renderGenreSections(genres);
            renderGrid(allBooksPoefo, gridPoefo);
        }

        await loadDuckDogBooks("fiction");
        setupSearch();
    } catch (err) {
        console.error("Erro ao carregar app:", err);
        if(gridPoefo) gridPoefo.innerHTML = "<p>Erro ao carregar livros da biblioteca.</p>";
    }
}

function listenForFeaturedBook(books) {
    try {
        if (typeof firebase === 'undefined' || !window.POEFO_FIREBASE_CONFIG) {
            throw new Error('Configuração do Firebase não disponível.');
        }
        if (!firebase.apps.length) firebase.initializeApp(window.POEFO_FIREBASE_CONFIG);

        firebase.database().ref('configuracoes/livroDestaqueId').on('value', snapshot => {
            const featuredBookId = snapshot.val();
            const featuredBook = books.find(book => String(book.id) === String(featuredBookId)) || books[0];
            renderHero(featuredBook);
        }, error => {
            console.warn('Não foi possível receber o livro em destaque do painel:', error);
        });
    } catch (error) {
        console.warn('Não foi possível conectar ao destaque do painel; mantendo o primeiro livro:', error);
    }
}

// --- RENDERIZAR LIVRO EM DESTAQUE ---
function renderHero(book) {
    if(!book || !heroContainer) return;
    heroContainer.innerHTML = `
        <div class="hero-poster-backdrop" style="background-image: url('${book.link_capa}')"></div>
        <div class="hero-poster-glow" aria-hidden="true"></div>
        <div class="hero-poster-cover">
            <img src="${book.link_capa}" alt="Capa de ${book.titulo}">
        </div>
        <div class="hero-content">
                <div class="hero-kicker-row">
                    <span class="hero-tag">Destaque da Semana</span>
                    <span class="hero-category">${book.genero || 'Poefo Library'}</span>
                </div>
            <h2 class="hero-title">${book.titulo}</h2>
            <p class="hero-desc">${book.sinopse ? book.sinopse.substring(0, 130) + '...' : 'Inicie sua leitura agora.'}</p>
                <div class="hero-poster-footer">
                    <span class="hero-poster-note">Uma leitura selecionada para você</span>
                    <button class="btn-primary" onclick="openBook('${encodeURIComponent(JSON.stringify(book))}')">Começar Leitura</button>
                </div>
        </div>
    `;
}

// --- RENDERIZAR CONTINUAR LENDO (ESTILO DA IMAGEM DE REFERÊNCIA) ---
async function renderMostRecentReading(books) {
    if (!books?.length) return;

    const progressEntries = await Promise.all(books.map(async book => ({
        book,
        progress: typeof loadUserBookProgress === 'function'
            ? await loadUserBookProgress(String(book.id))
            : null
    })));
    const recent = progressEntries
        .filter(entry => entry.progress && (Number(entry.progress.segundos) > 0 || Number(entry.progress.pagina) > 1))
        .sort((a, b) => Number(b.progress.atualizado_em || 0) - Number(a.progress.atualizado_em || 0))[0];

    renderContinueReading(recent?.book || books[0], recent?.progress || null);
}

function renderContinueReading(book, progress = null) {
    if(!continueReadingContainer || !book) return;

    const currentPage = Math.max(1, Number(progress?.pagina) || 1);
    const totalPages = Math.max(0, Number(progress?.paginas_totais) || 0);
    const savedProgress = totalPages ? Math.min(100, Math.round((currentPage / totalPages) * 100)) : 0;
    const progressLabel = totalPages
        ? `${savedProgress}% concluído`
        : `Página ${currentPage}`;

    continueReadingContainer.innerHTML = `
        <div class="cr-cover" style="background-image: url('${book.link_capa}')"></div>
        <div class="cr-info">
            <h3 class="cr-title">${book.titulo}</h3>
            <p class="cr-author">${book.autor}</p>
            <div class="cr-progress-bar-bg">
                <div class="cr-progress-fill" style="width: ${savedProgress}%"></div>
            </div>
            <div class="cr-progress-text">
                <span>${progressLabel}</span>
            </div>
        </div>
        <button class="btn-resume" onclick="openBook('${encodeURIComponent(JSON.stringify(book))}')">RESUME</button>
    `;
}

// --- RENDERIZAR CATEGORIAS E CAMPOS DE REDIRECIONAMENTO ---
function renderGenreSections(genres) {
    if(!genreSectionsContainer) return;

    genreSectionsContainer.innerHTML = genres.map((genre, index) => {
        const filtered = allBooksPoefo.filter(b => b.genero === genre);
        if (filtered.length === 0) return '';
        const latestBook = filtered[filtered.length - 1];

        // Pega as configurações de redirecionamento para esta posição ou aplica um padrão editável
        const redirectData = REDIRECT_CARDS_DATA[index] || {
            tag: "DESTAQUE POEFO",
            title: `Explorar mais em ${genre}`,
            desc: "Descubra novos títulos, avalie histórias e interaja com os autores.",
            btnText: "Ver categoria",
            btnUrl: "#",
            image: "../images/banner-criacao.svg"
        };

        return `
            <div class="genre-section">
                <h2 class="section-heading">${genre}</h2>
                <div class="scroll-list">
                    ${filtered.map(b => `
                        <div class="book-item" onclick="openBook('${encodeURIComponent(JSON.stringify(b))}')">
                            <div class="book-cover" style="background-image: url('${b.link_capa}')"></div>
                            <div class="book-title">${b.titulo}</div>
                            <div class="book-author-sub">${b.autor}</div>
                        </div>
                    `).join('')}
                </div>

                <!-- CAMPO DE REDIRECIONAMENTO DE CONTEÚDO INTERCALADO -->
                <div class="promo-redirect-card" style="--promo-cover: url('${latestBook.link_capa}'); --promo-image: url('${redirectData.image}')">
                    <div class="promo-redirect-content">
                        <span class="hero-tag" style="color: #bfdbfe;">${redirectData.tag}</span>
                        <h2>${redirectData.title}</h2>
                        <p>${redirectData.desc}</p>
                        <a href="${redirectData.btnUrl}" class="promo-redirect-btn">${redirectData.btnText}</a>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// --- RENDERIZAR GRID COMPLETO ---
function renderGrid(list, container, options = {}) {
    if (!container) return;
    if (list.length === 0) {
        container.innerHTML = "<p>Nenhum livro encontrado.</p>";
        return;
    }

    const openAction = options.externalLink ? 'openDuckDogBook' : 'openBook';
    container.innerHTML = list.map(b => `
        <div class="book-item" onclick="${openAction}('${encodeURIComponent(JSON.stringify(b))}')">
            <div class="book-cover" style="background-image: url('${b.link_capa}')"></div>
            <div class="book-info">
                <div class="book-title">${b.titulo}</div>
                <div class="book-author-sub">${b.autor}</div>
            </div>
        </div>
    `).join('');
}

// --- DUCKDOG API ---
async function loadDuckDogBooks(query = "fiction") {
    if (!gridDuckDog || !window.DuckDogApi) return;
    try {
        const books = await window.DuckDogApi.searchDuckDog(query);
        renderGrid(books, gridDuckDog, { externalLink: true });
    } catch (err) {
        console.error("Erro DuckDog:", err);
        gridDuckDog.innerHTML = '<p>Configure a API DuckDog para explorar novos livros.</p>';
    }
}

// --- FILTROS E PESQUISA ---
function renderFilters(genres) {
    if(!genreFilters) return;
    genreFilters.innerHTML = `<div class="genre-chip active" onclick="filterByGenre('Todos', this)">Todos</div>` +
        genres.map(g => `<div class="genre-chip" onclick="filterByGenre('${g}', this)">${g}</div>`).join('');
}

function setupSearch() {
    if(!searchInput) return;
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const term = e.target.value;
            if (term.length > 2) {
                loadDuckDogBooks(term);
                const filtered = allBooksPoefo.filter(b => b.titulo.toLowerCase().includes(term.toLowerCase()));
                renderGrid(filtered, gridPoefo);
                
                if(heroContainer) heroContainer.style.display = 'none';
                if(genreSectionsContainer) genreSectionsContainer.style.display = 'none';
            }
        }
    });
}

function setupFilterToggle() {
    const filterButton = document.getElementById('filter-btn-trigger');
    const filterContainer = document.getElementById('genre-filters');
    if (!filterButton || !filterContainer) return;

    filterButton.addEventListener('click', () => {
        const isCollapsed = filterContainer.classList.toggle('is-collapsed');
        filterButton.setAttribute('aria-expanded', String(!isCollapsed));
        filterButton.classList.toggle('is-active', !isCollapsed);
    });
}

window.filterByGenre = (genre, el) => {
    document.querySelectorAll('.genre-chip').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
    
    if (genre === 'Todos') {
        renderGrid(allBooksPoefo, gridPoefo);
        genreSectionsContainer.style.display = 'block';
        if(heroContainer) heroContainer.style.display = 'flex';
        loadDuckDogBooks("fiction");
    } else {
        renderGrid(allBooksPoefo.filter(b => b.genero === genre), gridPoefo);
        genreSectionsContainer.style.display = 'none';
        if(heroContainer) heroContainer.style.display = 'none';
        loadDuckDogBooks(genre); 
    }
};

window.openBook = (data) => {
    const bookData = JSON.parse(decodeURIComponent(data));
    sessionStorage.setItem('selectedBook', JSON.stringify(bookData));
    
    const userData = localStorage.getItem('userLogado');
    if (userData) sessionStorage.setItem('userProfile', userData);

    window.location.href = '/livro';
};

window.openDuckDogBook = (data) => {
    const bookData = JSON.parse(decodeURIComponent(data));
    if (!bookData.link_acesso) return;
    window.open(bookData.link_acesso, '_blank', 'noopener,noreferrer');
};

document.addEventListener('DOMContentLoaded', loadApp);