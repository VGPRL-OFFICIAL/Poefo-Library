// --- URLs de Acesso Público ---
const ALL_BOOKS_DATA_URL = window.POEFO_FIREBASE_URLS.allBooksDataUrl;
const ALL_POSTS_DATA_URL = window.POEFO_FIREBASE_URLS.allPostsDataUrl;
const POSTS_STORAGE_PATH = 'livros_json/posts.json';

// --- Variáveis Globais ---
const feedContainer = document.getElementById('feed-container');
const loadingMessage = document.getElementById('loading-message');
const errorMessage = document.getElementById('error-message');
const noResultsMessage = document.getElementById('no-results-message');

let booksMap = new Map();
let allPostsData = [];
let followingSet = new Set();
let currentSearchTerm = '';
let followingLoadError = false;

let currentUserId = sessionStorage.getItem('currentUserId') || null;
let currentUserName = sessionStorage.getItem('currentUserName') || 'Leitor Anônimo';
let currentUserPic = sessionStorage.getItem('currentUserPic') || '../images/user_ic.png';


// --- Funções de Utilitários ---
const formatTimeAgo = (timestamp) => {
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
};


// --- Normalização de posts e extração de hashtags ---
function normalizePost(raw) {
    const content = raw.content || raw.conteudo || raw.conteúdo || raw.contente || raw.conteúdo || raw.text || '';
    const timestamp = raw.timestamp || raw.time || Date.now();
    const id = raw.id || raw.postId || (Math.random() + '').slice(2);
    const likes = raw.likes || raw.Curtidas || raw.curtidas || 0;
    const comentarios = raw.comentarios || raw['comentários'] || raw.comments || [];

    const rawAuthor = raw.author || raw.autor || {};
    const author = {
        userId: rawAuthor.userId || rawAuthor.userID || raw.userId || raw.userID || rawAuthor.id || 'USER_ANONIMO',
        userName: rawAuthor.userName || rawAuthor.nome_usuario || rawAuthor.nome_completo || rawAuthor.user || raw.userName || 'Usuário Desconhecido',
        userProfilePic: rawAuthor.userProfilePic || rawAuthor.foto_perfil || rawAuthor.profilePic || rawAuthor.userProfile || '../images/user_ic.png'
    };

    // Normaliza anexo (livro ou imagem)
    let attachment = null;
    const a = raw.attachment || raw.anexo || raw.anexo_de_livro || null;
    if (a) {
        const bookId = a.bookId || a.bookID || a.id_livro || a.book || a.título || a.titulo;
        const imageUrl = a.url || a.link || a.imageUrl || a.imagem || a.image || a.src || a.link_imagem;

        if (bookId !== undefined && bookId !== null && String(bookId) !== 'nulo') {
            attachment = { type: 'book_attachment', bookId: String(bookId) };
        } else if (imageUrl) {
            attachment = { type: 'image', url: imageUrl };
        }
    }

    // também admite campos de imagem fora de `attachment`
    if (!attachment) {
        const altImage = raw.image || raw.imagem || raw.imageUrl || raw.img || raw.link_imagem;
        if (altImage) attachment = { type: 'image', url: altImage };
    }

    return { id, timestamp, content, attachment, likes, comentarios, author, raw };
}

function extractHashtagCounts(posts) {
    const counts = {};
    const regex = /#([\p{L}\p{N}_-]+)/gu;
    posts.forEach(p => {
        const textFields = [p.content, (p.raw && p.raw.título) || (p.raw && p.raw.title) || (p.raw && p.raw.conteúdo) || (p.raw && p.raw.content)];
        textFields.forEach(field => {
            if (!field) return;
            let m;
            while ((m = regex.exec(field)) !== null) {
                const tag = m[1].toLowerCase();
                counts[tag] = (counts[tag] || 0) + 1;
            }
        });
    });
    return counts;
}

function renderTrendsFromPosts(posts, limit = 5) {
    const trendsBox = document.querySelector('.trends-box');
    if (!trendsBox) return;

    const counts = extractHashtagCounts(posts);
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit);

    const inner = ['<h3>O que está acontecendo</h3>'];
    if (entries.length === 0) {
        inner.push('<div class="trend-item"><p class="font-bold">Sem tendências ainda</p></div>');
        trendsBox.innerHTML = inner.join('\n');
        return;
    }

    entries.forEach(([tag, count]) => {
        inner.push(`
            <div class="trend-item trend-clickable" data-tag="${tag}">
                <span class="trend-category">#</span>
                <p class="font-bold">${tag}</p>
                <span class="trend-posts">${count} post(s)</span>
            </div>
        `);
    });

    trendsBox.innerHTML = inner.join('\n');

    // adiciona listeners para pesquisa por tendência
    trendsBox.querySelectorAll('.trend-clickable').forEach(el => {
        el.addEventListener('click', () => {
            const tag = el.getAttribute('data-tag');
            if (tag) filterPosts(`#${tag}`);
        });
    });
}


// ----------------------------------------------------------------------
// FUNÇÕES DE NAVEGAÇÃO (APONTA APENAS PARA LIVRO.HTML)
// ----------------------------------------------------------------------

/**
 * Salva o livro na sessão e redireciona para a página de detalhes (/livro).
 * @param {string} bookId ID do livro para carregar.
 */
function openBookDetails(bookId) {
    const book = booksMap.get(String(bookId));
    if (book) {
        // Salva o objeto completo no sessionStorage.
        sessionStorage.setItem('selectedBook', JSON.stringify(book)); 
        
        // Redireciona APENAS para a página de detalhes do livro
        window.location.href = '/livro';
    } else {
        console.error('Livro não encontrado para ID:', bookId);
        alert('Erro: Livro não encontrado.');
    }
}


// ----------------------------------------------------------------------
// FUNÇÃO: CARREGA DADOS DO PERFIL (RTDB)
// ----------------------------------------------------------------------
/**
 * Busca a foto_perfil do usuário logado no Realtime Database.
 */
async function loadCurrentUserProfile() {
    // Se o usuário for anônimo (ID de fallback sem o formato RTDB), ignora a busca
    if (!currentUserId || currentUserId.includes('ANONIMO')) {
        return;
    }

    try {
        const userRef = db.ref(`usuarios/${currentUserId}`);
        const snapshot = await userRef.once('value');
        
        if (snapshot.exists()) {
            const userData = snapshot.val();
            
            // Eu atualizo o nome exibido.
            currentUserName = userData.nome_completo || userData.nome_usuario || 'Usuário';
            
            // Eu carrego a foto de perfil salva em foto_perfil.
            currentUserPic = userData.foto_perfil || '../images/user_ic.png'; 
            
            sessionStorage.setItem('currentUserName', currentUserName);
            sessionStorage.setItem('currentUserPic', currentUserPic);
            
            // Eu atualizo imediatamente o avatar da barra superior no celular.
            const mobilePicElement = document.getElementById('mobile-profile-pic');
            if(mobilePicElement) {
                mobilePicElement.src = currentUserPic;
            }

        } else {
            console.warn(`Dados do usuário ${currentUserId} não encontrados no RTDB. Usando fallback.`);
        }
    } catch (error) {
        console.error("Erro ao carregar dados do perfil:", error);
    }
}

// --- Seguidores / Seguindos (RTDB) ---
async function loadFollowingSet() {
    followingSet = new Set();
    try {
        if (!currentUserId || currentUserId.includes('ANONIMO') || typeof db === 'undefined') return followingSet;
        const snap = await db.ref(`follows/${currentUserId}`).once('value');
        const val = snap.val() || {};
        Object.keys(val).forEach(k => { if (val[k] === true) followingSet.add(k); });
    } catch (err) {
        followingLoadError = true;
        console.error('Erro ao carregar lista de seguidos:', err);
        const filterButton = document.getElementById('feed-filter-btn');
        if (filterButton) filterButton.title = 'Não foi possível carregar sua lista de seguidos.';
    }
    return followingSet;
}

function applyFollowFilter(posts) {
    const checkbox = document.getElementById('follow-filter-checkbox');
    if (!checkbox || !checkbox.checked) return posts;
    return posts.filter(p => {
        const authorId = (p.author && p.author.userId) || p.userId || (p.raw && p.raw.autor && p.raw.autor.userId);
        return authorId && followingSet.has(String(authorId));
    });
}

function filterPostsBySearch(posts) {
    const term = currentSearchTerm.toLocaleLowerCase('pt-BR');
    if (!term) return posts;
    return posts.filter(post => {
        if (post.content && post.content.toLocaleLowerCase('pt-BR').includes(term)) return true;
        const authorFields = [
            post.author?.userName,
            post.author?.fullName,
            post.author?.nome_usuario,
            post.author?.nome_completo,
            post.userName,
            post.nome_usuario,
            post.nome_completo
        ];
        if (authorFields.some(value => String(value || '').toLocaleLowerCase('pt-BR').includes(term))) return true;
        if (post.attachment?.type === 'book_attachment') {
            const book = booksMap.get(String(post.attachment.bookId));
            if (`${book?.titulo || ''} ${book?.autor || ''}`.toLocaleLowerCase('pt-BR').includes(term)) return true;
        }
        return false;
    });
}

function renderCurrentFeed() {
    renderFilteredFeed(applyFollowFilter(filterPostsBySearch(allPostsData)));
}

function shareFeedPost(post) {
    const attachment = post.attachment?.type === 'image'
        ? { type: 'image', url: post.attachment.url }
        : post.attachment?.type === 'book_attachment'
            ? {
                type: 'book',
                book: (() => {
                    const book = booksMap.get(String(post.attachment.bookId));
                    return book ? {
                        id: String(book.id),
                        titulo: book.titulo || 'Livro',
                        autor: book.autor || '',
                        link_capa: book.link_capa || '',
                        link_acesso: book.link_acesso || ''
                    } : null;
                })()
            }
            : null;
    sessionStorage.setItem('pendingFeedPostShare', JSON.stringify({
        postId: String(post.id),
        authorName: post.author?.userName || 'Um leitor',
        text: String(post.content || '').slice(0, 1000),
        attachment
    }));
    window.location.href = '/chat';
}

async function deleteFeedPost(post) {
    if (!currentUserId || currentUserId.includes('ANONIMO')) {
        alert('Entre na sua conta para excluir uma publicação.');
        return;
    }
    if (!window.confirm('Deseja excluir esta publicação? Esta ação não pode ser desfeita.')) return;

    try {
        const auth = firebase.auth();
        const authUser = auth.currentUser || await new Promise(resolve => {
            const unsubscribe = auth.onAuthStateChanged(user => {
                unsubscribe();
                resolve(user);
            });
        });
        if (!authUser) throw new Error('Sua sessão expirou. Entre novamente para excluir a publicação.');
        const deletePost = firebase.functions().httpsCallable('deleteFeedPost');
        await deletePost({ profileId: currentUserId, postId: String(post.id) });
        allPostsData = allPostsData.filter(item => String(item.id) !== String(post.id));
        renderCurrentFeed();
    } catch (error) {
        console.error('Não foi possível excluir a publicação:', error);
        alert(`Não foi possível excluir a publicação: ${error.message || 'tente novamente.'}`);
    }
}

// ----------------------------------------------------------------------
// FUNÇÃO: ATUALIZA O posts.json NO FIREBASE STORAGE
// ----------------------------------------------------------------------
async function updatePostJson(postId, updateType, value) {
    const postsRef = storage.ref(POSTS_STORAGE_PATH);

    try {
        const response = await fetch(ALL_POSTS_DATA_URL);
        if (!response.ok) throw new Error(`Falha ao baixar posts.json: ${response.statusText}`);
        let allPosts = await response.json().catch(() => []);

        let postFound = false;
        allPosts = allPosts.map(post => {
            if (post.id === postId) {
                postFound = true;
                if (updateType === 'likes') {
                    post.likes = value;
                } else if (updateType === 'comment') {
                    post.comentarios = post.comentarios || [];
                    post.comentarios.push(value);
                }
            }
            return post;
        });

        if (!postFound) {
            console.warn(`Post ID ${postId} não encontrado para atualização.`);
            return;
        }

        const updatedJsonString = JSON.stringify(allPosts, null, 2);
        const blob = new Blob([updatedJsonString], { type: 'application/json' });

        const uploadTask = postsRef.put(blob);
        uploadTask.on('state_changed',
            () => {}, 
            (error) => {
                console.error("Erro ao fazer upload do posts.json atualizado:", error);
            },
            () => {
                console.log(`posts.json atualizado com sucesso (${updateType}).`);
            }
        );

    } catch (error) {
        console.error("Erro no processo de atualização do posts.json:", error);
    }
}


// ----------------------------------------------------------------------
// FUNÇÕES DE AÇÕES DO POST
// ----------------------------------------------------------------------
function handleLike(postId, likeIcon, likeCountElement) {
    if (!currentUserId || currentUserId.includes('ANONIMO')) {
        alert("Você precisa estar logado para curtir! (Usuário: USER_ANONIMO_001)");
        return;
    }

    const likeRef = db.ref(`post_likes/${postId}/${currentUserId}`);
    const likesCountRef = db.ref(`post_stats/${postId}/likes`);

    likeRef.once('value', (snapshot) => {
        let newLikeCount;

        if (snapshot.exists() && snapshot.val() === true) {
            // Descurtir
            likeRef.remove();
            likesCountRef.transaction((current) => {
                newLikeCount = Math.max(0, (current || 0) - 1);
                return newLikeCount;
            }).then(() => {
                likeIcon.classList.replace('fa-solid', 'fa-regular');
                likeIcon.style.color = 'var(--color-text-subtle)';
                likeCountElement.textContent = newLikeCount;
                updatePostJson(postId, 'likes', newLikeCount);
            });

        } else {
            // Curtir
            likeRef.set(true);
            likesCountRef.transaction((current) => {
                newLikeCount = (current || 0) + 1;
                return newLikeCount;
            }).then(() => {
                likeIcon.classList.replace('fa-regular', 'fa-solid');
                likeIcon.style.color = 'var(--color-like-active)';
                likeCountElement.textContent = newLikeCount;
                updatePostJson(postId, 'likes', newLikeCount);
            });
        }
    });
}

function handleComment(postId, inputElement) {
    const commentText = inputElement.value.trim();
    if (!commentText) return;

    if (!currentUserId || currentUserId.includes('ANONIMO')) {
        alert("Você precisa estar logado para comentar! (Usuário: USER_ANONIMO_001)");
        return;
    }

    const newComment = {
        userId: currentUserId,
        userName: currentUserName,
        // Usa a foto de perfil carregada
        userProfilePic: currentUserPic, 
        text: commentText,
        timestamp: Date.now()
    };

    const commentsCountRef = db.ref(`post_stats/${postId}/comments`);
    commentsCountRef.transaction((current) => (current || 0) + 1);

    updatePostJson(postId, 'comment', newComment);

    renderNewComment(postId, newComment);

    inputElement.value = '';
}

function renderNewComment(postId, comment) {
    const commentList = document.getElementById(`comments-list-${postId}`);
    if (!commentList) return;

    const commentItem = document.createElement('div');
    commentItem.classList.add('comment-item');
    commentItem.innerHTML = `
        <img src="${comment.userProfilePic || '../images/user_ic.png'}" 
             onerror="this.src='../images/user_ic.png';"
             alt="Pic" class="avatar" style="width: 20px; height: 20px; margin: 0; flex-shrink: 0;">
        <span class="comment-user">${comment.userName}:</span>
        <span class="comment-text">${comment.text}</span>
    `;
    commentList.prepend(commentItem); 

    const countElement = document.querySelector(`#comments-count-${postId}`);
    if (countElement) {
        countElement.textContent = parseInt(countElement.textContent) + 1;
    }
}

function toggleComments(postId) {
    const commentsSection = document.getElementById(`comments-section-${postId}`);
    if (commentsSection) {
        commentsSection.classList.toggle('hidden-comment-section');
    }
}

function goToProfile(userId) {
    alert(`Navegando para o perfil de: ${userId}`);
}

// ----------------------------------------------------------------------
// FUNÇÕES DE BUSCA
// ----------------------------------------------------------------------

async function filterPosts(searchTerm) {
    currentSearchTerm = String(searchTerm || '').trim();
    renderCurrentFeed();
}

function renderFilteredFeed(posts) {
    feedContainer.innerHTML = '';
    noResultsMessage.classList.add('hidden');

    if (posts.length === 0) {
        noResultsMessage.classList.remove('hidden');
        return;
    }

    posts.sort((a, b) => b.timestamp - a.timestamp);

    posts.forEach(post => {
        const postElement = createPostElement(post);
        feedContainer.appendChild(postElement);
    });
}


// ----------------------------------------------------------------------
// FUNÇÃO DE CRIAÇÃO DO POST
// ----------------------------------------------------------------------

function createPostElement(post) {
    const postDiv = document.createElement('div');
    postDiv.classList.add('post');

    const author = post.author || {
        userId: post.userId || 'USER_ANONIMO',
        userName: post.userName || 'Usuário Desconhecido',
        userProfilePic: '../images/user_ic.png' 
    };

    const postAuthorId = author.userId;
    const postUserName = author.userName;
    // Eu uso a foto salva no JSON e mantenho um fallback caso ela não carregue.
    const postProfilePic = author.userProfilePic || '../images/user_ic.png';
    
    const postHandle = (postUserName.replace(/\s/g, '').toLowerCase() + postAuthorId.slice(-4));
    const isOwnPost = Boolean(currentUserId && String(postAuthorId) === String(currentUserId));

    let attachmentHTML = '';
    let book = null;

    if (post.attachment && post.attachment.type === 'book_attachment') {
        book = booksMap.get(String(post.attachment.bookId));
        if (book) {
            attachmentHTML = `
                <div class="book-attachment clickable-attachment" data-book-id="${book.id}" title="Ver Detalhes do Livro">
                    <img src="${book.link_capa || 'https://via.placeholder.com/60x90?text=Capa'}"
                             onerror="this.src='https://via.placeholder.com/60x90?text=Capa';"
                             alt="Capa do Livro" class="book-cover">
                    <div class="book-info">
                        <p class="book-title">${book.titulo}</p>
                        <p class="book-author">Por: ${book.autor || 'Desconhecido'}</p>
                        <p class="book-genre"><i class="fa-solid fa-book-open"></i> Clique para Detalhes</p>
                    </div>
                </div>
            `;
        }
    } else if (post.attachment && post.attachment.type === 'image') {
        const imgUrl = post.attachment.url;
        attachmentHTML = `
            <div class="image-attachment">
                <img src="${imgUrl}" alt="Imagem do Post" class="post-image" onerror="this.src='https://via.placeholder.com/300x200?text=Imagem';">
            </div>
        `;
    }

    const existingComments = post.comentarios || [];
    let commentsListHTML = '';
    [...existingComments].sort((a, b) => b.timestamp - a.timestamp).slice(0, 3).forEach(comment => {
        commentsListHTML += `
            <div class="comment-item">
                <img src="${comment.userProfilePic || '../images/user_ic.png'}" 
                     onerror="this.src='../images/user_ic.png';"
                     alt="Pic" class="avatar" style="width: 20px; height: 20px; margin: 0; flex-shrink: 0;">
                <span class="comment-user">${comment.userName}:</span>
                <span class="comment-text">${comment.text}</span>
            </div>
        `;
    });


    // ESTRUTURA FINAL DO POST
    postDiv.innerHTML = `
        <div class="post-main-content">
                <img src="${postProfilePic}" 
                 onerror="this.src='../images/user_ic.png';" 
                 alt="Foto de Perfil" class="avatar profile-link" data-user-id="${postAuthorId}" title="Ver Perfil">

            <div class="post-content-wrapper">
                <div class="post-header-row">
                    <div class="post-header-info profile-link" data-user-id="${postAuthorId}">
                        <span class="username">${postUserName}</span>
                        <span class="handle">@${postHandle}</span>
                        <span class="time">· ${formatTimeAgo(post.timestamp)}</span>
                    </div>
                    <div class="post-menu">
                        <button class="post-menu-toggle" type="button" aria-label="Mais opções da publicação" aria-expanded="false">
                            <i class="fa-solid fa-ellipsis"></i>
                        </button>
                        <div class="post-menu-popover" hidden>
                            <button class="post-share-action" type="button"><i class="fa-solid fa-paper-plane"></i> Enviar para contato</button>
                            ${isOwnPost ? '<button class="post-delete-action" type="button"><i class="fa-regular fa-trash-can"></i> Excluir publicação</button>' : ''}
                        </div>
                    </div>
                </div>

                <p class="post-text">${post.content}</p>

                ${attachmentHTML}

                <div class="post-actions">
                    <button class="action comment-toggle-button" data-post-id="${post.id}">
                        <i class="fa-regular fa-comment"></i> <span id="comments-count-${post.id}">${existingComments.length}</span>
                    </button>
                    <button class="action like" data-post-id="${post.id}">
                        <i class="fa-regular fa-heart" id="like-icon-${post.id}" style="color: var(--color-text-subtle);"></i>
                        <span id="likes-count-${post.id}">${post.likes || 0}</span>
                    </button>
                </div>
            </div>
        </div>

        <div class="comments-section hidden-comment-section" id="comments-section-${post.id}">
            <div class="comment-list" id="comments-list-${post.id}">
                ${commentsListHTML}
            </div>
            <div class="comment-input-area">
                <input type="text" id="comment-input-${post.id}" placeholder="Adicione seu comentário...">
                <button id="comment-button-${post.id}" title="Enviar Comentário">
                    <i class="fa-solid fa-paper-plane"></i>
                </button>
            </div>
        </div>
    `;

    const menuToggle = postDiv.querySelector('.post-menu-toggle');
    const menuPopover = postDiv.querySelector('.post-menu-popover');
    menuToggle.addEventListener('click', event => {
        event.stopPropagation();
        const expanded = menuToggle.getAttribute('aria-expanded') === 'true';
        menuToggle.setAttribute('aria-expanded', String(!expanded));
        menuPopover.hidden = expanded;
    });
    menuPopover.addEventListener('click', event => event.stopPropagation());
    postDiv.querySelector('.post-share-action').addEventListener('click', () => shareFeedPost(post));
    postDiv.querySelector('.post-delete-action')?.addEventListener('click', () => deleteFeedPost(post));

    // 1. Listeners de Likes, Comentários, etc. (Mantidos)
    const likeButton = postDiv.querySelector(`.action.like`);
    const likeIcon = postDiv.querySelector(`#like-icon-${post.id}`);
    const likeCountElement = postDiv.querySelector(`#likes-count-${post.id}`);

    if (likeButton) {
        likeButton.addEventListener('click', () => {
            handleLike(post.id, likeIcon, likeCountElement);
        });
    }

    const commentToggleButton = postDiv.querySelector('.comment-toggle-button');
    if (commentToggleButton) {
        commentToggleButton.addEventListener('click', () => {
            toggleComments(post.id);
        });
    }

    const commentInput = postDiv.querySelector(`#comment-input-${post.id}`);
    const commentButton = postDiv.querySelector(`#comment-button-${post.id}`);

    commentButton.addEventListener('click', () => {
        handleComment(post.id, commentInput);
    });

    commentInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            handleComment(post.id, commentInput);
        }
    });

    // Eu abro os detalhes do livro quando alguém seleciona o anexo.
    const bookAttachment = postDiv.querySelector('.clickable-attachment');
    if (bookAttachment) {
        bookAttachment.addEventListener('click', () => {
            const bookId = bookAttachment.getAttribute('data-book-id');
            if (bookId) {
                openBookDetails(bookId); 
            }
        });
    }

    // Navegar para perfil ao clicar em avatar ou header
    postDiv.querySelectorAll('.profile-link').forEach(el => {
        el.addEventListener('click', (e) => {
            const uid = el.getAttribute('data-user-id');
            if (uid) {
                sessionStorage.setItem('viewUserId', uid);
                window.location.href = '/perfil-usuario';
            }
        });
    });

    // 4. Monitoramento RTDB (Likes e estado do usuário)
    const statsRef = db.ref(`post_stats/${post.id}`);
    const likesRef = db.ref(`post_likes/${post.id}/${currentUserId}`);

    statsRef.on('value', (snapshot) => {
        const stats = snapshot.val() || {};
        const likes = stats.likes !== undefined ? stats.likes : (post.likes || 0);
        const comments = stats.comments !== undefined ? stats.comments : existingComments.length;

        const countElement = postDiv.querySelector(`#likes-count-${post.id}`);
        if (countElement) countElement.textContent = likes;

        const commentCountElement = postDiv.querySelector(`#comments-count-${post.id}`);
        if (commentCountElement) commentCountElement.textContent = comments;
    });

    likesRef.once('value', (likeSnapshot) => {
        if (likeIcon && likeSnapshot.exists() && likeSnapshot.val() === true) {
            likeIcon.classList.replace('fa-regular', 'fa-solid');
            likeIcon.style.color = 'var(--color-like-active)';
        }
    });

    return postDiv;
}

// ----------------------------------------------------------------------
// FUNÇÃO DE INICIALIZAÇÃO PRINCIPAL
// ----------------------------------------------------------------------
async function loadFeed() {
    // Eu carrego os dados do usuário conectado, incluindo a foto do perfil.
    await loadCurrentUserProfile(); 
    
    feedContainer.innerHTML = '';
    loadingMessage.classList.remove('hidden');
    errorMessage.classList.add('hidden');
    noResultsMessage.classList.add('hidden');
    booksMap = new Map();

    try {
        const [booksResponse, postsResponse] = await Promise.all([
            fetch(ALL_BOOKS_DATA_URL, { cache: 'no-store' }),
            fetch(ALL_POSTS_DATA_URL, { cache: 'no-store' })
        ]);

        if (!booksResponse.ok) throw new Error("Falha ao carregar Livros.");
        const allBooks = await booksResponse.json();
        allBooks.forEach(book => booksMap.set(String(book.id), book));

        if (!postsResponse.ok) throw new Error("Falha ao carregar Posts.");
        const rawPosts = await postsResponse.json().catch(() => []);

        // Normaliza posts, carrega seguidos e renderiza tendências
        allPostsData = rawPosts.map(normalizePost);
        await loadFollowingSet();
        renderTrendsFromPosts(allPostsData);

        loadingMessage.classList.add('hidden');

        if (allPostsData.length === 0) {
            feedContainer.innerHTML = `<div class="loading-message">Seu Feed está vazio. Seja o primeiro a publicar!</div>`;
            return;
        }

        renderCurrentFeed();

    } catch (error) {
        console.error("Erro ao carregar o Feed:", error);
        loadingMessage.classList.add('hidden');
        errorMessage.classList.remove('hidden');
        errorMessage.textContent = `❌ Erro ao carregar: ${error.message}. Verifique a conexão com o Firebase Storage.`;
    }
}


// --- Inicialização e Listeners de Busca ---
document.addEventListener('DOMContentLoaded', () => {
    if (typeof db !== 'undefined' && typeof storage !== 'undefined') {
        loadFeed(); 
    } else {
        errorMessage.textContent = "Erro: Firebase SDKs não carregados.";
        errorMessage.classList.remove('hidden');
    }

    const searchInputDesktop = document.getElementById('search-input-desktop');
    const searchInputMobile = document.getElementById('search-input-mobile');

    if (searchInputDesktop) {
        searchInputDesktop.addEventListener('input', (e) => filterPosts(e.target.value));
    }
    if (searchInputMobile) {
        searchInputMobile.addEventListener('input', (e) => filterPosts(e.target.value));
    }

    const followCheckbox = document.getElementById('follow-filter-checkbox');
    const filterButton = document.getElementById('feed-filter-btn');
    const syncFollowFilterButton = () => {
        const active = Boolean(followCheckbox?.checked);
        filterButton?.classList.toggle('is-active', active);
        filterButton?.setAttribute('aria-pressed', String(active));
        if (filterButton) filterButton.title = active ? 'Mostrando apenas seguidos' : 'Mostrar apenas seguidos';
    };
    filterButton?.addEventListener('click', () => {
        if (!currentUserId || currentUserId.includes('ANONIMO')) {
            alert('Entre na sua conta para filtrar as publicações de quem você segue.');
            return;
        }
        if (followCheckbox) {
            if (!followCheckbox.checked && followingLoadError) {
                alert('Não foi possível carregar sua lista de pessoas seguidas. Verifique as regras de leitura do Realtime Database.');
                return;
            }
            followCheckbox.checked = !followCheckbox.checked;
            followCheckbox.dispatchEvent(new Event('change'));
        }
    });
    if (followCheckbox) {
        followCheckbox.addEventListener('change', () => {
            syncFollowFilterButton();
            renderCurrentFeed();
        });
    }
    document.addEventListener('click', event => {
        document.querySelectorAll('.post-menu').forEach(menu => {
            if (menu.contains(event.target)) return;
            const toggle = menu.querySelector('.post-menu-toggle');
            const popover = menu.querySelector('.post-menu-popover');
            if (toggle && popover) {
                toggle.setAttribute('aria-expanded', 'false');
                popover.hidden = true;
            }
        });
    });
    syncFollowFilterButton();
});