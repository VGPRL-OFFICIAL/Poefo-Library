// script_livro.js

// ----------------------------------------------------------------------
// Variáveis Globais (Usuário e Firebase)
// ----------------------------------------------------------------------
const db = window.db || null; 
const LIVROS_RTDB_PATH = 'livros'; 

// Variáveis de estado
let currentUserId = '-ID-ANONIMO-'; 
let currentUserName = 'Leitor Anônimo';
let currentUserPic = '../images/user_ic.png';
let currentBookId = null; 
let currentBookData = null; 
let isDataLoaded = false; 

// ----------------------------------------------------------------------
// FUNÇÕES DE UTILIDADE (Mantidas)
// ----------------------------------------------------------------------
function getBookData() {
    const sessionData = sessionStorage.getItem('selectedBook');
    return sessionData ? JSON.parse(sessionData) : null;
}

function getClassificationIconPath(classification) {
    const match = String(classification).match(/\d+/);
    const age = match ? match[0] : 'L';
    return `../images/classification_idication_${age}.png`;
}

function createBookInvitePayload(book) {
    return {
        id: String(book.id),
        titulo: book.titulo || 'Livro',
        autor: book.autor || '',
        sinopse: book.sinopse || '',
        genero: book.genero || '',
        classificacao: book.classificacao || 'Livre',
        link_capa: book.link_capa || '',
        link_acesso: book.link_acesso || ''
    };
}

const formatTimeAgo = (timestamp) => {
    if (typeof timestamp !== 'number' || timestamp > Date.now()) {
        return 'agora'; 
    }
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 7) {
        return new Date(timestamp).toLocaleDateString('pt-BR');
    }
    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
};

// ----------------------------------------------------------------------
// FUNÇÕES DE COMENTÁRIOS (Envio e Exclusão)
// ----------------------------------------------------------------------

async function handleDeleteComment(bookId, commentId, commentElement) {
    if (!db || !bookId || !commentId) return alert("Erro: Dados de comentário ausentes.");

    if (commentElement.dataset.userId !== currentUserId) {
         alert("❌ Você não tem permissão para apagar este comentário, pois ele não pertence ao seu login atual.");
         return;
    }

    if (confirm("Tem certeza que deseja apagar este comentário?")) {
        const commentRef = db.ref(`book_comments/${bookId}/${commentId}`);
        try {
            await commentRef.remove();
        } catch (error) {
            console.error("Erro ao apagar comentário:", error);
            alert(`❌ Falha ao apagar o comentário. Erro: ${error.message}`);
        }
    }
}

function renderComment(comment, commentId, prepend = false) { 
    const commentList = document.getElementById('book-comments-list');
    if (!commentList) return;

    const commentItem = document.createElement('div');
    commentItem.classList.add('comment-item');
    commentItem.dataset.commentId = commentId; 
    commentItem.dataset.userId = comment.userId; 

    const timeDisplay = formatTimeAgo(comment.timestamp);
    
    const deleteButtonHTML = (comment.userId === currentUserId) ? 
        `<span class="delete-icon" role="button" aria-label="Apagar Comentário">
            <i class="fas fa-trash-alt"></i>
        </span>` : '';

    commentItem.innerHTML = `
        <img src="${comment.userProfilePic || '../images/user_ic.png'}" 
             onerror="this.src='../images/user_ic.png';"
             alt="Pic" class="avatar comment-avatar">
        <div class="comment-content-wrapper">
            <span class="comment-user">${comment.userName}</span>
            <span class="comment-text">${comment.text}</span>
            <div class="comment-actions">
                <span class="comment-time">${timeDisplay}</span>
                ${deleteButtonHTML}
            </div>
        </div>
    `;

    const deleteIcon = commentItem.querySelector('.delete-icon');
    if (deleteIcon) {
        deleteIcon.addEventListener('click', (e) => {
            e.stopPropagation(); 
            handleDeleteComment(currentBookId, commentId, commentItem); 
        });
    }

    if (prepend) {
        commentList.prepend(commentItem);
    } else {
        commentList.appendChild(commentItem);
    }
}

//  FUNÇÃO DE ENVIO COM VERIFICAÇÕES ROBUSTAS
async function handleComment(inputElement, bookId) {
    const commentText = inputElement.value.trim();
    if (!commentText) return alert("Por favor, digite um comentário.");

    //  VERIFICAÇÕES CRUCIAIS PARA ENVIO
    if (!db) return alert("❌ Erro: O serviço de Banco de Dados (Firebase) não está disponível.");
    if (!bookId) return alert("❌ Erro: O ID do livro não foi carregado. Tente recarregar a página.");
    
    if (currentUserId === '-ID-ANONIMO-') {
        alert("⚠️ Você precisa estar logado para comentar.");
        return;
    }

    const commentButton = document.querySelector('.bottom-bar .send-icon');
    commentButton.style.opacity = '0.5'; 
    
    // Aqui eu crio o nó book_comments quando ele ainda não existe.
    const commentRef = db.ref(`book_comments/${bookId}`).push();
    
    const newComment = {
        userId: currentUserId, 
        userName: currentUserName,
        userProfilePic: currentUserPic, 
        text: commentText,
        timestamp: firebase.database.ServerValue.TIMESTAMP 
    };

    try {
        await commentRef.set(newComment);
        inputElement.value = ''; 
    } catch (error) {
        console.error("Erro ao adicionar comentário:", error);
        // Esta mensagem de erro é a mais importante para debug!
        alert(`❌ Falha ao salvar o comentário. Isso pode ser um erro de conexão. Erro: ${error.message}`);
    } finally {
        commentButton.style.opacity = '1';
    }
}

function loadBookComments(bookId) {
    if (!db || !bookId) return;
    const commentsRef = db.ref(`book_comments/${bookId}`);
    const commentsList = document.getElementById('book-comments-list');
    const commentsCountElement = document.getElementById('comments-count');

    if (commentsList) commentsList.innerHTML = '';
    
    // Carrega comentários existentes e configura listeners em tempo real (child_added/removed)
    // ... (A lógica de loadBookComments deve ser mantida da resposta anterior) ...
     commentsRef.orderByChild('timestamp').once('value', snapshot => {
        let count = 0;
        const commentsArray = [];
        snapshot.forEach(childSnapshot => {
            const comment = childSnapshot.val();
            comment.commentId = childSnapshot.key;
            if (typeof comment.timestamp !== 'number') {
                comment.timestamp = Date.now(); 
            }
            commentsArray.push(comment);
        });

        commentsArray.sort((a, b) => b.timestamp - a.timestamp).forEach(comment => {
            renderComment(comment, comment.commentId);
            count++;
        });
        
        if (commentsCountElement) {
            commentsCountElement.textContent = count;
        }

        commentsRef.on('child_added', (data) => {
            const newCommentId = data.key; 
            if (commentsList.querySelector(`[data-comment-id="${newCommentId}"]`)) return;

            const newComment = data.val();
            renderComment(newComment, newCommentId, true); 
            const currentCount = parseInt(commentsCountElement.textContent) || 0;
            commentsCountElement.textContent = currentCount + 1;
        });
        
        commentsRef.on('child_removed', (data) => {
             const deletedCommentId = data.key;
             const commentElement = commentsList.querySelector(`.comment-item[data-comment-id="${deletedCommentId}"]`);
             
             if(commentElement) {
                 commentElement.remove();
                 
                 const currentCount = parseInt(commentsCountElement.textContent) || 0;
                 commentsCountElement.textContent = Math.max(0, currentCount - 1);
             }
        });
    });
}


// ----------------------------------------------------------------------
// FUNÇÕES DE RENDERIZAÇÃO E LISTENERS (Mantidas)
// ----------------------------------------------------------------------

async function loadBookDetails() {
    if (isDataLoaded) return;
    
    const bookSessionData = getBookData();
    const container = document.getElementById('book-details-container');

    if (!bookSessionData || !bookSessionData.id || !db) {
        container.innerHTML = '<p style="color:red; padding:20px; text-align:center;">Erro ao carregar dados do livro ou Firebase.</p>';
        return;
    }
    
    currentBookId = bookSessionData.id; 

    const bookRef = db.ref(`${LIVROS_RTDB_PATH}/${currentBookId}`);
    
    try {
        const snapshot = await bookRef.once('value');
        const bookRTDB = snapshot.val();

        currentBookData = { ...bookSessionData, ...bookRTDB };
        
        renderBookDetails(currentBookData);
        setupEventListeners(currentBookData); 
        
        isDataLoaded = true;
        
    } catch (error) {
        console.error("Erro ao buscar detalhes do livro no RTDB:", error);
        container.innerHTML = `<p style="color:red; padding:20px; text-align:center;">Falha ao carregar dados dinâmicos do livro: ${error.message}</p>`;
    }
}

function renderBookDetails(book) {
    const container = document.getElementById('book-details-container');
    const coverUrl = book.link_capa || 'https://via.placeholder.com/150x200?text=Capa+Ausente';
    const title = book.titulo || 'Título Não Informado';
    const author = book.autor || 'Autor Desconhecido';
    const sinopse = book.sinopse || 'Sem sinopse disponível.';
    const genero = book.genero || 'Gênero Não Informado';
    const linkAcesso = book.link_acesso || '';
    const classificationValue = book.classificacao || 'Livre';
    const classificationIconPath = getClassificationIconPath(classificationValue);
    
    const authorLine = `Autor: ${author}`;

    container.innerHTML = `
        <div class="main-content-header" style="--book-cover-url: url('${coverUrl}');">
            </div>

        <div class="book-details-section">
            <img src="${coverUrl}" class="book-cover-large" alt="Capa do Livro">
            <h1 class="book-title-detail">${title}</h1>
            <p class="book-author-detail">${authorLine}</p>
            <p class="book-metadata-tags">${genero}</p>
            <div class="book-classification">
                <img src="${classificationIconPath}" alt="" class="classification-icon">
                <span>Classificação indicativa: ${classificationValue}</span>
            </div>
        </div>

        <div class="read-button-container-central">
            <button id="ler-btn-main" class="ler-btn-main ${!linkAcesso ? 'disabled' : ''}" ${!linkAcesso ? 'disabled' : ''}>Ler Livro</button>
            <div class="book-invite-actions">
                <button id="invite-publication-btn" class="book-invite-btn">Convidar para ler</button>
                <button id="invite-contact-btn" class="book-invite-btn book-invite-btn-secondary">Convidar contato</button>
            </div>
        </div>

        <div class="book-section sinopse-section">
            <h3 class="section-title">Sinopse</h3>
            <p class="book-sinopse">${sinopse}</p>
        </div>

        <div class="book-section comments-section">
            <h3 class="section-title">Comentários (<span id="comments-count">0</span>)</h3>
            <div class="comment-list" id="book-comments-list">
                </div>
        </div>
        
        <div style="height: 70px;"></div>
    `;
}

function setupEventListeners(book) {
     if (!book) return;
     
    const lerBtnMain = document.getElementById('ler-btn-main');
    if (lerBtnMain && book.link_acesso) {
        lerBtnMain.onclick = function() {
            sessionStorage.setItem('readerUrl', book.link_acesso);
            sessionStorage.setItem('readerBookId', String(book.id));
            window.location.href = '/leitor';
        };
    }

    document.getElementById('invite-publication-btn')?.addEventListener('click', () => {
        sessionStorage.setItem('pendingBookPublicationInvite', JSON.stringify(createBookInvitePayload(book)));
        window.location.href = '/publicar';
    });

    document.getElementById('invite-contact-btn')?.addEventListener('click', () => {
        sessionStorage.setItem('pendingBookChatInvite', JSON.stringify(createBookInvitePayload(book)));
        window.location.href = '/chat';
    });

    const commentInput = document.querySelector('.bottom-bar .search-input');
    const commentButton = document.querySelector('.bottom-bar .send-icon');
    if (commentInput) {
        commentInput.placeholder = "Adicione seu comentário sobre o livro..."; 
    }

    if (commentInput && commentButton && db) {
        commentButton.addEventListener('click', () => {
            handleComment(commentInput, currentBookId);
        });

        commentInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault(); 
                handleComment(commentInput, currentBookId);
            }
        });
        
        loadBookComments(currentBookId);
    } else if (!db) {
         if (commentInput) commentInput.disabled = true;
         if (commentButton) commentButton.style.opacity = '0.5';
         if (commentInput) commentInput.placeholder = "Comentários desativados: Conexão Firebase falhou.";
    }
}

// ----------------------------------------------------------------------
// LISTENER DE AUTENTICAÇÃO (MÉTODO SEGURO)
// ----------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', function() {
    if (typeof firebase !== 'undefined' && typeof firebase.auth === 'function') {
        firebase.auth().onAuthStateChanged((user) => {
            if (user) {
                currentUserId = sessionStorage.getItem('currentUserId') || user.uid;
                currentUserName = sessionStorage.getItem('currentUserName') || user.displayName || 'Usuário Poefo';
                currentUserPic = sessionStorage.getItem('currentUserPic') || user.photoURL || '../images/user_ic.png';
            } else {
                currentUserId = sessionStorage.getItem('currentUserId') || '-ID-ANONIMO-';
                currentUserName = sessionStorage.getItem('currentUserName') || 'Leitor Anônimo';
                currentUserPic = sessionStorage.getItem('currentUserPic') || '../images/user_ic.png';
            }
            
            // Carrega o conteúdo principal APÓS definir o estado do usuário
            loadBookDetails();
        });
    } else {
        console.error("Firebase Auth SDK não carregado. O login não será verificado.");
        loadBookDetails(); 
    }
});