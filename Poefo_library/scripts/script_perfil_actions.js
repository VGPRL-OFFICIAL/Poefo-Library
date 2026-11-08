// Script auxiliar para página de perfil: listar posts do usuário e permitir exclusão
const POSTS_JSON_URL = 'https://firebasestorage.googleapis.com/v0/b/captu-libraly.firebasestorage.app/o/livros_json%2Fposts.json?alt=media&token=e7b7b6fb-275a-45e3-9482-7830189c671f';
const POSTS_STORAGE_PATH = 'livros_json/posts.json';
const BOOKS_JSON_URL = 'https://firebasestorage.googleapis.com/v0/b/captu-libraly.firebasestorage.app/o/livros_json%2Flivros.json?alt=media&token=3eaf739c-b9fc-45b7-ab15-800d9058655a';

async function fetchSavedBooks(userId) {
    if (!userId || typeof db === 'undefined') return [];
    try {
        const savedSnap = await db.ref(`user_collections/${userId}`).once('value');
        const savedData = savedSnap.val() || {};
        return Object.keys(savedData).filter(key => savedData[key] === true);
    } catch (error) {
        console.error('Erro ao carregar livros salvos:', error);
        return [];
    }
}

async function renderSavedBooksGrid(userId) {
    const container = document.getElementById('saved-books-grid');
    if (!container) return;
    container.innerHTML = '';

    const currentUserId = userId || sessionStorage.getItem('currentUserId');
    if (!currentUserId) {
        container.innerHTML = '<div class="post-item placeholder"><span>Faça login para ver seus livros salvos.</span></div>';
        return;
    }

    const savedIds = await fetchSavedBooks(currentUserId);
    if (savedIds.length === 0) {
        container.innerHTML = '<div class="post-item placeholder"><span>Nenhum livro salvo na coleção ainda.</span></div>';
        return;
    }

    try {
        const resp = await fetch(BOOKS_JSON_URL);
        if (!resp.ok) throw new Error('Falha ao carregar dados dos livros.');
        const allBooks = await resp.json();
        const savedBooks = allBooks.filter(book => savedIds.includes(String(book.id)));

        if (savedBooks.length === 0) {
            container.innerHTML = '<div class="post-item placeholder"><span>Nenhum livro encontrado na coleção.</span></div>';
            return;
        }

        savedBooks.forEach(book => {
            const bookEl = document.createElement('div');
            bookEl.className = 'saved-book-card';
            bookEl.innerHTML = `
                <img src="${book.link_capa || '../images/user_ic.png'}" alt="${book.titulo}" class="saved-book-cover" onerror="this.src='../images/user_ic.png';">
                <div class="saved-book-info">
                    <strong>${book.titulo || 'Livro sem título'}</strong>
                    <span>${book.autor || 'Autor desconhecido'}</span>
                </div>
            `;
            bookEl.addEventListener('click', () => {
                sessionStorage.setItem('selectedBook', JSON.stringify(book));
                window.location.href = '/livro';
            });
            container.appendChild(bookEl);
        });
    } catch (error) {
        console.error('Erro ao renderizar livros salvos:', error);
        container.innerHTML = '<div class="post-item placeholder"><span>Erro ao carregar a coleção.</span></div>';
    }
}

async function fetchAllPosts() {
    const resp = await fetch(POSTS_JSON_URL);
    if (!resp.ok) return [];
    return await resp.json().catch(() => []);
}

async function deletePostJson(postId) {
    try {
        const resp = await fetch(POSTS_JSON_URL);
        if (!resp.ok) throw new Error('Falha ao baixar posts.json');
        let posts = await resp.json().catch(() => []);
        posts = posts.filter(p => p.id !== postId);

        const blob = new Blob([JSON.stringify(posts, null, 2)], { type: 'application/json' });
        const storageRef = firebase.storage().ref(POSTS_STORAGE_PATH);
        const uploadTask = storageRef.put(blob);
        return new Promise((resolve, reject) => {
            uploadTask.on('state_changed', null, reject, () => resolve(true));
        });
    } catch (err) {
        console.error('Erro ao deletar post:', err);
        throw err;
    }
}

async function renderUserPostsGrid(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const currentUserId = sessionStorage.getItem('currentUserId');
    if (!currentUserId) return;

    const allPosts = await fetchAllPosts();
    const myPosts = allPosts.filter(p => {
        if (!p) return false;
        if (p.userId && String(p.userId) === String(currentUserId)) return true;
        if (p.author && p.author.userId && String(p.author.userId) === String(currentUserId)) return true;
        if (p.autor && p.autor.userId && String(p.autor.userId) === String(currentUserId)) return true;
        return false;
    });

    container.innerHTML = '';
    if (myPosts.length === 0) {
        container.innerHTML = '<div class="post-item placeholder"><span>Nenhuma postagem encontrada</span></div>';
        return;
    }

    myPosts.sort((a,b)=>b.timestamp - a.timestamp).forEach(post => {
        const el = document.createElement('div');
        el.className = 'post-item has-content';
        const img = (post.attachment && post.attachment.type === 'image' && post.attachment.url)
            ? `<img src="${post.attachment.url}" class="post-image-cover">`
            : (post.anexo_url ? `<img src="${post.anexo_url}" class="post-image-cover">` : (post.imagem_url ? `<img src="${post.imagem_url}" class="post-image-cover">` : ''));
        const text = post.content || post.conteudo || post.conteúdo || post.texto || post.titulo || '';
        el.innerHTML = `
            ${img}
            <div class="post-text-snippet">${(text||'').substring(0,120)}</div>
            <button class="botao-acao btn-delete-post" data-post-id="${post.id}" style="position:absolute;bottom:6px;left:6px;">Apagar</button>
        `;
        container.appendChild(el);
    });

    container.querySelectorAll('.btn-delete-post').forEach(btn => {
        btn.addEventListener('click', async () => {
            const pid = btn.getAttribute('data-post-id');
            if (!confirm('Deseja realmente apagar esta publicação?')) return;
            try {
                await deletePostJson(pid);
                await renderUserPostsGrid(containerId);
            } catch (err) {
                alert('Erro ao apagar a publicação. Veja o console.');
            }
        });
    });
}

// Auto-renderiza quando a página carregar se existir o container padrão
document.addEventListener('DOMContentLoaded', () => {
    const currentUserId = sessionStorage.getItem('currentUserId');
    if (document.getElementById('grid-posts-container')) {
        renderUserPostsGrid('grid-posts-container');
    }
    if (document.getElementById('saved-books-grid')) {
        renderSavedBooksGrid(currentUserId);
    }
});
