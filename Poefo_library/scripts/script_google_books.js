// script_google_books.js

const GOOGLE_BOOKS_API_URL = 'https://www.googleapis.com/books/v1/volumes';

async function searchBooks(query, maxResults = 20) {
    try {
        const response = await fetch(`${GOOGLE_BOOKS_API_URL}?q=${encodeURIComponent(query)}&maxResults=${maxResults}`);
        const data = await response.json();
        return data.items || [];
    } catch (error) {
        console.error('Erro ao buscar livros:', error);
        return [];
    }
}

function mapBookData(volumeInfo, id) {
    return {
        id: id,
        titulo: volumeInfo.title || 'Título Desconhecido',
        autor: (volumeInfo.authors && volumeInfo.authors.join(', ')) || 'Autor Desconhecido',
        sinopse: volumeInfo.description || 'Sem descrição disponível.',
        genero: (volumeInfo.categories && volumeInfo.categories.join(', ')) || 'Gênero Não Informado',
        link_capa: (volumeInfo.imageLinks && volumeInfo.imageLinks.thumbnail) || 'https://via.placeholder.com/150x200?text=Capa+Indisponível',
        link_acesso: (volumeInfo.previewLink) || '',
        classificacao: 'Livre', // Padrão
        likes: 0,
        divas: 0,
        salvos: 0
    };
}

function createBookItem(bookData) {
    const item = document.createElement('div');
    item.className = 'book-item';
    item.innerHTML = `
        <div class="book-cover" style="background-image: url('${bookData.link_capa}');"></div>
        <div class="book-info">
            <div class="book-title">${bookData.titulo}</div>
            <div class="book-author">${bookData.autor}</div>
        </div>
    `;
    item.addEventListener('click', () => {
        sessionStorage.setItem('selectedBook', JSON.stringify(bookData));
        window.location.href = '/livro';
    });
    return item;
}

function createCarouselItem(bookData) {
    const item = document.createElement('div');
    item.className = 'featured-card carousel-item';
    item.style.setProperty('--book-cover-url', `url('${bookData.link_capa}')`);
    item.innerHTML = `
        <div class="featured-cover" style="background-image: url('${bookData.link_capa}');"></div>
        <div class="featured-details">
            <div class="detail-tag">Lançamento</div>
            <h3 class="detail-title">${bookData.titulo}</h3>
            <p class="detail-author">${bookData.autor}</p>
            <p class="detail-description">${bookData.sinopse.substring(0, 100)}...</p>
            <div class="detail-footer">
                <span>Leia Agora</span>
                <button class="detail-button">Ver</button>
            </div>
        </div>
    `;
    item.querySelector('.detail-button').addEventListener('click', (e) => {
        e.stopPropagation();
        sessionStorage.setItem('selectedBook', JSON.stringify(bookData));
        window.location.href = '/livro';
    });
    item.addEventListener('click', () => {
        sessionStorage.setItem('selectedBook', JSON.stringify(bookData));
        window.location.href = '/livro';
    });
    return item;
}

async function loadSearchResults(query) {
    const resultsList = document.getElementById('search-results-list');
    resultsList.innerHTML = '';
    const books = await searchBooks(query);
    books.forEach(book => {
        const bookData = mapBookData(book.volumeInfo, book.id);
        resultsList.appendChild(createBookItem(bookData));
    });
}

async function loadPopularBooks() {
    const popularList = document.getElementById('popular-books-list');
    popularList.innerHTML = '';
    const books = await searchBooks('orderBy=relevance', 10);
    books.forEach(book => {
        const bookData = mapBookData(book.volumeInfo, book.id);
        popularList.appendChild(createBookItem(bookData));
    });
}

async function loadRecentBooks() {
    const recentContainer = document.getElementById('recent-books-container');
    recentContainer.innerHTML = '';
    const books = await searchBooks('orderBy=newest', 5);
    books.forEach(book => {
        const bookData = mapBookData(book.volumeInfo, book.id);
        recentContainer.appendChild(createCarouselItem(bookData));
    });
}

document.addEventListener('DOMContentLoaded', () => {
    // Carregar livros iniciais
    loadPopularBooks();
    loadRecentBooks();

    // Evento de busca
    const searchBtn = document.getElementById('search-btn');
    const searchInput = document.getElementById('search-input');
    searchBtn.addEventListener('click', () => {
        const query = searchInput.value.trim();
        if (query) {
            loadSearchResults(query);
        }
    });
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            searchBtn.click();
        }
    });

    // Eventos de gêneros
    const genreBtns = document.querySelectorAll('.genre-btn');
    genreBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const genre = btn.dataset.genre;
            loadSearchResults(`subject:${genre}`);
        });
    });
});