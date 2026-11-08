const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const pages = [
  'html/cadastro.html',
  'html/chat.html',
  'html/feed.html',
  'html/livro.html',
  'html/login.html',
  'html/perfil.html',
  'html/perfil-usuario.html',
  'games/anagrama-literario.html',
  'games/caca-palavras.html',
  'games/memoria-literaria.html',
  'games/quiz-literario.html'
];
const scriptFiles = [
  'script_progress.js',
  'script_publicador.js',
  'script_feed.js',
  'script_perfil_actions.js'
];

function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, content) { fs.writeFileSync(p, content, 'utf8'); }

function insertConfigImport(filePath, importPath) {
  let content = read(filePath);
  if (content.includes('firebase-config.js')) return false;
  const marker = '<script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>';
  const idx = content.indexOf(marker);
  if (idx === -1) return false;
  const before = content.slice(0, idx + marker.length);
  const after = content.slice(idx + marker.length);
  content = before + '\n    <script src="' + importPath + '"></script>' + after;
  write(filePath, content);
  return true;
}

function replaceFirebaseConfig(filePath) {
  let content = read(filePath);
  const regex = /const firebaseConfig = \{[\s\S]*?\};\s*(?:if \(!firebase\.apps\.length\) firebase\.initializeApp\(firebaseConfig\);|firebase\.initializeApp\(firebaseConfig\);)/g;
  const replaced = content.replace(regex, 'if (!firebase.apps.length) firebase.initializeApp(window.POEFO_FIREBASE_CONFIG);');
  if (replaced !== content) {
    write(filePath, replaced);
    return true;
  }
  return false;
}

function stripHtmlComments(filePath) {
  let content = read(filePath);
  const cleaned = content.replace(/<!--([\s\S]*?)-->/g, '');
  if (cleaned !== content) {
    write(filePath, cleaned);
    return true;
  }
  return false;
}

function replaceScriptUrls(filePath, replacementMap) {
  let content = read(filePath);
  let updated = content;
  for (const [pattern, replacement] of replacementMap) {
    updated = updated.replace(pattern, replacement);
  }
  if (updated !== content) {
    write(filePath, updated);
    return true;
  }
  return false;
}

for (const relative of pages) {
  const filePath = path.join(projectRoot, relative);
  insertConfigImport(filePath, '../scripts/firebase-config.js');
  replaceFirebaseConfig(filePath);
  stripHtmlComments(filePath);
}

// Update game pages import path if needed
for (const relative of ['games/anagrama-literario.html', 'games/caca-palavras.html', 'games/memoria-literaria.html', 'games/quiz-literario.html']) {
  const filePath = path.join(projectRoot, relative);
  insertConfigImport(filePath, '../scripts/firebase-config.js');
}

const mainImports = [
  ['script_progress.js', 'const FIREBASE_PROGRESS_CONFIG = window.POEFO_FIREBASE_CONFIG;'],
  ['script_publicador.js', 'const firebaseConfig = window.POEFO_FIREBASE_CONFIG;'],
  ['script_feed.js', 'const ALL_BOOKS_DATA_URL = window.POEFO_FIREBASE_URLS.allBooksDataUrl;\nconst ALL_POSTS_DATA_URL = window.POEFO_FIREBASE_URLS.allPostsDataUrl;'],
  ['script_perfil_actions.js', 'const POSTS_JSON_URL = window.POEFO_FIREBASE_URLS.allPostsDataUrl;\nconst BOOKS_JSON_URL = window.POEFO_FIREBASE_URLS.allBooksDataUrl;']
];

for (const [filename, replacement] of mainImports) {
  const filePath = path.join(projectRoot, 'scripts', filename);
  let content = read(filePath);
  if (filename === 'script_feed.js') {
    content = content.replace(/const ALL_BOOKS_DATA_URL = [^\n]*\nconst ALL_POSTS_DATA_URL = [^\n]*\n/, replacement + '\n');
  } else if (filename === 'script_perfil_actions.js') {
    content = content.replace(/const POSTS_JSON_URL = [^\n]*\nconst BOOKS_JSON_URL = [^\n]*\n/, replacement + '\n');
  } else if (filename === 'script_publicador.js') {
    const regex = /const firebaseConfig = \{[\s\S]*?\};/;
    content = content.replace(regex, replacement);
  } else if (filename === 'script_progress.js') {
    const regex = /const FIREBASE_PROGRESS_CONFIG = \{[\s\S]*?\};/;
    content = content.replace(regex, replacement);
  }
  write(filePath, content);
}

// Update service worker import path and config usage
const swPath = path.join(projectRoot, 'firebase-messaging-sw.js');
let swContent = read(swPath);
if (!swContent.includes('firebase-config.js')) {
  swContent = swContent.replace(/importScripts\('https:\/\/www\.gstatic\.com\/firebasejs\/8\.10\.1\/firebase-messaging\.js'\);\n\n/, "importScripts('https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging.js');\nimportScripts('./scripts/firebase-config.js');\n\n");
}
swContent = swContent.replace(/firebase\.initializeApp\([\s\S]*?\);/, 'firebase.initializeApp(self.POEFO_FIREBASE_CONFIG);');
write(swPath, swContent);

console.log('Centralization complete');
