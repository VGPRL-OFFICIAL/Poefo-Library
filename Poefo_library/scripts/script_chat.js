// ===== CHAT SCRIPT COMPLETO COM FIREBASE ESTRUTURADO =====
// Estrutura RTDB: /chat/{conversaId}/messages/{msgId}
//                 /chat_users/{userId}/conversations/{convId}
//                 /chat_metadata/{convId}

const db = firebase.database();
const storage = firebase.storage();

let currentUserId = sessionStorage.getItem('currentUserId') || null;
let currentUserName = sessionStorage.getItem('currentUserName') || 'Usuário Anônimo';
let currentUserAvatar = sessionStorage.getItem('currentUserAvatar') || null;

let currentConvId = null;
let currentParticipants = [];
let activeMessagesRef = null;
let activeMessagesQuery = null;
let activeMessageAddedHandler = null;
let activeMessageRemovedHandler = null;
let activePresenceListeners = [];
let presenceConnectionRef = null;
let presenceConnectionHandler = null;
let allUsers = {};
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let isStartingRecording = false;
let recordingStream = null;
let recordingConvId = null;
let selectedParticipantIds = new Set();
let pendingBookChatInvite = null;
let pendingGameChallenge = null;
let pendingFeedPostShare = null;
let notificationAudioContext = null;
let lastNotificationSoundAt = 0;
const notificationTimestamps = new Map();
const notificationUnreadCounts = new Map();
let chatSilentMode = false;
let foregroundMessagingListenerRegistered = false;
const recentNotificationEvents = new Map();
let bookCatalogPromise = null;
let selectedBookClub = null;
let conversationBookClub = null;

function updateChatViewportHeight() {
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    document.documentElement.style.setProperty('--chat-visible-height', `${Math.round(viewportHeight)}px`);
}

updateChatViewportHeight();
window.addEventListener('resize', updateChatViewportHeight);
window.addEventListener('orientationchange', updateChatViewportHeight);
window.visualViewport?.addEventListener('resize', updateChatViewportHeight);

function primeNotificationAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
        if (!notificationAudioContext || notificationAudioContext.state === 'closed') {
            notificationAudioContext = new AudioContextClass();
        }
        if (notificationAudioContext.state === 'suspended') {
            notificationAudioContext.resume().catch(error => {
                console.warn('Não foi possível ativar o áudio das notificações:', error);
            });
        }
    } catch (error) {
        console.warn('Não foi possível preparar o áudio das notificações:', error);
    }
}

function playNotificationSound() {
    if (chatSilentMode) return;
    const now = Date.now();
    if (now - lastNotificationSoundAt < 900) return;
    lastNotificationSoundAt = now;
    primeNotificationAudio();
    if (!notificationAudioContext || notificationAudioContext.state !== 'running') return;

    [0, 0.16].forEach((delay, index) => {
        const oscillator = notificationAudioContext.createOscillator();
        const gain = notificationAudioContext.createGain();
        const startAt = notificationAudioContext.currentTime + delay;
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(index === 0 ? 740 : 880, startAt);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(0.12, startAt + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.22);
        oscillator.connect(gain);
        gain.connect(notificationAudioContext.destination);
        oscillator.start(startAt);
        oscillator.stop(startAt + 0.23);
    });
}

document.addEventListener('pointerdown', primeNotificationAudio);
document.addEventListener('keydown', primeNotificationAudio);

function showDesktopNotification(title, body, icon, tag) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
        navigator.serviceWorker?.ready.then(registration => registration.showNotification(title, {
            body,
            icon,
            tag: tag || `chat-${title}-${body}`,
            renotify: false,
            silent: chatSilentMode
        })).catch(error => {
            console.error('Não foi possível mostrar a notificação do chat:', error);
        });
    }
}

function notifyIncomingMessage(convId, title, body, icon, messageId) {
    if (isConversationVisible(convId)) return;
    const now = Date.now();
    const eventKey = `${convId}:${messageId || `${title}:${body}`}`;
    if (recentNotificationEvents.has(eventKey)) return;
    recentNotificationEvents.set(eventKey, now);
    if (recentNotificationEvents.size > 200) {
        for (const [key, timestamp] of recentNotificationEvents) {
            if (now - timestamp > 10 * 60 * 1000) recentNotificationEvents.delete(key);
        }
    }
    playNotificationSound();
    showDesktopNotification(title, body, icon, `chat-${convId}`);
}

function updateNotificationsButton() {
    const button = document.getElementById('chat-notifications-toggle');
    if (!button) return;
    const supported = 'Notification' in window && 'serviceWorker' in navigator && Boolean(firebase.messaging);
    button.hidden = !supported;
    if (!supported) return;

    const permission = Notification.permission;
    const isEnabled = permission === 'granted' && Boolean(sessionStorage.getItem('chatFcmTokenReady'));
    const isMuted = chatSilentMode;
    button.classList.toggle('is-enabled', isEnabled);
    button.classList.toggle('is-silent', isEnabled && isMuted);
    button.setAttribute('aria-pressed', String(isEnabled && !isMuted));
    button.disabled = permission === 'denied';
    button.title = permission === 'denied'
        ? 'Notificações bloqueadas pelo navegador'
        : !isEnabled ? 'Ativar notificações'
            : isMuted ? 'Ativar som das notificações' : 'Desativar som das notificações';
    button.setAttribute('aria-label', button.title);
    button.innerHTML = isEnabled
        ? `<i class="fas fa-bell${isMuted ? '-slash' : ''}" aria-hidden="true"></i>`
        : '<i class="fas fa-bell-slash" aria-hidden="true"></i>';
}

async function enableChatNotifications() {
    const button = document.getElementById('chat-notifications-toggle');
    if (!('Notification' in window)) {
        alert('Este navegador não oferece suporte a notificações.');
        return;
    }

    const tokenReady = Boolean(sessionStorage.getItem('chatFcmTokenReady'));
    if (Notification.permission === 'granted' && tokenReady) {
        await toggleChatSilentMode();
        return;
    }

    if (Notification.permission === 'denied') {
        alert('As notificações estão bloqueadas nas permissões do navegador. Permita notificações para este site e tente novamente.');
        return;
    }

    if (button) button.disabled = true;
    try {
        if (Notification.permission !== 'granted') {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                throw new Error('Permissão não concedida. Autorize notificações para receber mensagens fora do chat.');
            }
        }
        await registerFcmAndSaveToken();
        if (!sessionStorage.getItem('chatFcmTokenReady')) {
            throw new Error('O navegador não forneceu um token push. Verifique a configuração Web Push/VAPID do Firebase.');
        }
        if (chatSilentMode) {
            const savePreference = firebase.functions().httpsCallable('setChatSilentMode');
            await savePreference({ profileId: currentUserId, silentMode: false });
            chatSilentMode = false;
            localStorage.setItem(`chatSilentMode:${currentUserId}`, 'false');
        }
    } catch (error) {
        console.error('Não foi possível ativar as notificações do chat:', error);
        alert(`Não foi possível ativar as notificações: ${error.message || 'tente novamente.'}`);
    } finally {
        updateNotificationsButton();
        if (button) button.disabled = Notification.permission === 'denied';
    }
}

async function toggleChatSilentMode() {
    const nextValue = !chatSilentMode;
    const button = document.getElementById('chat-notifications-toggle');
    if (button) button.disabled = true;
    try {
        const savePreference = firebase.functions().httpsCallable('setChatSilentMode');
        await savePreference({ profileId: currentUserId, silentMode: nextValue });
        chatSilentMode = nextValue;
        localStorage.setItem(`chatSilentMode:${currentUserId}`, String(chatSilentMode));
        updateNotificationsButton();
    } catch (error) {
        console.error('Não foi possível atualizar o modo silencioso:', error);
        alert(`Não foi possível atualizar o modo silencioso: ${error.message || 'tente novamente.'}`);
    } finally {
        if (button) button.disabled = false;
    }
}

// ===== HELPER FUNCTIONS =====
function getConvIdFromParticipants(arr) {
    const sorted = Array.from(new Set(arr.map(String))).sort();
    if (sorted.length === 2) return `direct_${sorted[0]}_${sorted[1]}`;
    return `group_${sorted.join('_')}`;
}

function getOtherParticipantId(convId, participants) {
    const otherIds = participants.filter(id => id && id !== currentUserId);
    if (otherIds.length === 1) return otherIds[0];
    if (otherIds.length > 1 || !convId.startsWith('direct_')) return null;

    const directParticipants = convId.slice('direct_'.length);
    if (directParticipants.startsWith(`${currentUserId}_`)) {
        return directParticipants.slice(currentUserId.length + 1) || null;
    }
    if (directParticipants.endsWith(`_${currentUserId}`)) {
        return directParticipants.slice(0, -(currentUserId.length + 1)) || null;
    }
    return null;
}

function getParticipantDisplayName(user, fallback) {
    return user?.nome_usuario || user?.nome_completo || user?.handle || fallback;
}

function getConversationEntries(data, previousOrder = []) {
    const conversations = new Map();
    Object.entries(data).forEach(([convId, meta]) => {
        const participants = Array.isArray(meta.participants)
            ? meta.participants
            : Object.keys(meta.participants || {});
        const participantIds = participants.filter(Boolean).map(String).sort();
        const isDirect = convId.startsWith('direct_') && participantIds.length === 2;
        const key = isDirect ? `direct:${participantIds.join('_')}` : `conversation:${convId}`;
        const existing = conversations.get(key);
        if (!existing) {
            conversations.set(key, { convId, meta });
            return;
        }

        const currentIsOpen = convId === currentConvId;
        const existingIsOpen = existing.convId === currentConvId;
        const isNewer = Number(meta.lastTimestamp) > Number(existing.meta.lastTimestamp);
        const candidate = currentIsOpen || (!existingIsOpen && isNewer)
            ? { convId, meta }
            : existing;
        candidate.meta.unreadCount = Math.max(
            Number(existing.meta.unreadCount) || 0,
            Number(meta.unreadCount) || 0
        );
        conversations.set(key, candidate);
    });

    const entries = Array.from(conversations.values())
        .sort((a, b) => (Number(b.meta.lastTimestamp) || 0) - (Number(a.meta.lastTimestamp) || 0));
    const pinnedIndex = previousOrder.indexOf(currentConvId);
    const activeIndex = entries.findIndex(entry => entry.convId === currentConvId);
    if (pinnedIndex >= 0 && activeIndex >= 0 && activeIndex !== pinnedIndex) {
        const [activeEntry] = entries.splice(activeIndex, 1);
        entries.splice(Math.min(pinnedIndex, entries.length), 0, activeEntry);
    }
    return entries;
}

async function safeReadRef(path) {
    try {
        const snap = await db.ref(path).once('value');
        return snap.exists() ? snap.val() : null;
    } catch (e) {
        console.warn('Read error:', path, e);
        return null;
    }
}

function timeAgo(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    if (diff < 60000) return 'agora';
    if (diff < 3600000) return `${Math.floor(diff/60000)}m`;
    if (diff < 86400000) return `${Math.floor(diff/3600000)}h`;
    const d = new Date(timestamp);
    return d.toLocaleDateString('pt-BR');
}

function setHeaderPresence(text, online) {
    const status = document.getElementById('header-status');
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('is-online', Boolean(online));
    status.classList.toggle('is-offline', !online);
}

function isConversationVisible(convId) {
    if (convId !== currentConvId) return false;
    return window.matchMedia('(min-width: 769px)').matches
        || document.body.classList.contains('mobile-chat-open');
}

function clearConversationPresenceListeners() {
    activePresenceListeners.forEach(({ ref, handler }) => ref.off('value', handler));
    activePresenceListeners = [];
}

function watchConversationPresence(participants) {
    clearConversationPresenceListeners();
    const conversationId = currentConvId;
    const otherIds = participants.filter(id => id && id !== currentUserId);
    if (otherIds.length === 0) {
        setHeaderPresence('Offline', false);
        return;
    }

    const onlineUsers = new Set();
    const updateStatus = () => {
        if (otherIds.length === 1) {
            const online = onlineUsers.has(otherIds[0]);
            setHeaderPresence(online ? 'Online' : 'Offline', online);
            return;
        }
        const count = onlineUsers.size;
        setHeaderPresence(count ? `${count} online` : 'Ninguém online', count > 0);
    };

    otherIds.forEach(userId => {
        const ref = db.ref(`presence/${userId}/connections`);
        const handler = snapshot => {
            if (currentConvId !== conversationId || !currentParticipants.includes(userId)) return;
            if (snapshot.exists() && Object.keys(snapshot.val() || {}).length > 0) {
                onlineUsers.add(userId);
            } else {
                onlineUsers.delete(userId);
            }
            updateStatus();
        };
        ref.on('value', handler, error => {
            console.error(`Não foi possível consultar a presença de ${userId}:`, error);
            if (currentConvId === conversationId && currentParticipants.includes(userId)) {
                setHeaderPresence('Status indisponível', false);
            }
        });
        activePresenceListeners.push({ ref, handler });
    });
}

function startPresenceTracking() {
    if (presenceConnectionRef && presenceConnectionHandler) {
        presenceConnectionRef.off('value', presenceConnectionHandler);
    }
    presenceConnectionRef = db.ref('.info/connected');
    presenceConnectionHandler = snapshot => {
        if (snapshot.val() !== true || !currentUserId) return;
        const connectionRef = db.ref(`presence/${currentUserId}/connections`).push();
        connectionRef.onDisconnect().remove()
            .then(() => connectionRef.set(true))
            .catch(error => {
                console.error('Não foi possível ativar seu status online:', error);
                if (currentParticipants.length > 0) {
                    setHeaderPresence('Status indisponível', false);
                }
            });
    };
    presenceConnectionRef.on('value', presenceConnectionHandler, error => {
        console.error('Não foi possível acompanhar a conexão do chat:', error);
        setHeaderPresence('Status indisponível', false);
    });
}

async function sendBookInviteToConversation(convId, participants, title) {
    if (!pendingBookChatInvite) return false;
    await openConversation(convId, participants, title);
    const book = pendingBookChatInvite;
    const bookTitle = book.titulo || 'este livro';
    const sent = await sendMessage(`📚 ${currentUserName} convidou você para ler "${bookTitle}".`, null, null, book);
    if (!sent) return false;

    pendingBookChatInvite = null;
    sessionStorage.removeItem('pendingBookChatInvite');
    document.body.classList.remove('book-invite-mode');
    const invitePrompt = document.getElementById('book-invite-prompt');
    if (invitePrompt) invitePrompt.style.display = 'none';
    loadConversations();
    return true;
}

async function sendGameChallengeToConversation(convId, participants, title) {
    if (!pendingGameChallenge) return false;
    if (!currentUserId) {
        alert('Entre na sua conta para desafiar um contato.');
        return false;
    }
    await openConversation(convId, participants, title);
    const sent = await sendMessage(pendingGameChallenge.text);
    if (!sent) return false;

    pendingGameChallenge = null;
    sessionStorage.removeItem('pendingGameChallenge');
    document.body.classList.remove('game-challenge-mode');
    const challengePrompt = document.getElementById('game-challenge-prompt');
    if (challengePrompt) challengePrompt.style.display = 'none';
    loadConversations();
    return true;
}

async function sendFeedPostToConversation(convId, participants, title) {
    if (!pendingFeedPostShare) return false;
    await openConversation(convId, participants, title);
    const share = pendingFeedPostShare;
    const text = `📨 ${share.authorName || 'Um leitor'} compartilhou uma publicação:\n${share.text || 'Confira esta publicação.'}`;
    const imageUrl = share.attachment?.type === 'image' ? share.attachment.url : null;
    const book = share.attachment?.type === 'book' ? share.attachment.book : null;
    const sent = await sendMessage(text, imageUrl, imageUrl ? 'image/jpeg' : null, book);
    if (!sent) return false;

    pendingFeedPostShare = null;
    sessionStorage.removeItem('pendingFeedPostShare');
    document.body.classList.remove('feed-post-share-mode');
    const prompt = document.getElementById('feed-post-share-prompt');
    if (prompt) prompt.style.display = 'none';
    loadConversations();
    return true;
}

async function shareFeedPostToContact(userId, userName) {
    if (!currentUserId) {
        alert('Entre na sua conta para compartilhar uma publicação.');
        return;
    }

    const participants = [currentUserId, userId];
    const convId = getConvIdFromParticipants(participants);
    try {
        const metaRef = db.ref(`chat_metadata/${convId}`);
        const existingMeta = await metaRef.once('value');
        const meta = existingMeta.val() || {
            title: userName,
            participants: { [currentUserId]: true, [userId]: true },
            createdBy: currentUserId,
            createdAt: Date.now(),
            lastMessage: '',
            lastTimestamp: Date.now(),
            avatar: allUsers[userId]?.foto_perfil || null
        };
        if (!existingMeta.exists()) await metaRef.set(meta);
        await db.ref(`chat_users/${currentUserId}/conversations/${convId}`).update({ ...meta, unreadCount: 0 });
        closeNewGroupModal();
        const sent = await sendFeedPostToConversation(convId, meta.participants || participants, meta.title || userName);
        if (!sent) throw new Error('A publicação não foi enviada.');
    } catch (error) {
        console.error('Não foi possível compartilhar a publicação:', error);
        alert(`Não foi possível compartilhar a publicação: ${error.message}`);
    }
}

async function inviteBookToContact(userId, userName) {
    if (!currentUserId) {
        alert('Entre na sua conta para convidar um contato.');
        return;
    }

    const participants = [currentUserId, userId];
    const convId = getConvIdFromParticipants(participants);
    try {
        const metaRef = db.ref(`chat_metadata/${convId}`);
        const existingMeta = await metaRef.once('value');
        const meta = existingMeta.val() || {
            title: userName,
            participants: { [currentUserId]: true, [userId]: true },
            createdBy: currentUserId,
            createdAt: Date.now(),
            lastMessage: '',
            lastTimestamp: Date.now(),
            avatar: allUsers[userId]?.foto_perfil || null
        };
        if (!existingMeta.exists()) await metaRef.set(meta);
        await db.ref(`chat_users/${currentUserId}/conversations/${convId}`).update({ ...meta, unreadCount: 0 });
        closeNewGroupModal();
        const sent = await sendBookInviteToConversation(convId, meta.participants || participants, meta.title || userName);
        if (!sent) throw new Error('A mensagem não foi enviada.');
    } catch (error) {
        console.error('Não foi possível enviar convite ao contato:', error);
        alert(`Não foi possível enviar o convite: ${error.message}`);
    }
}

async function challengeContact(userId, userName) {
    if (!currentUserId) {
        alert('Entre na sua conta para desafiar um contato.');
        return;
    }

    const participants = [currentUserId, userId];
    const convId = getConvIdFromParticipants(participants);
    try {
        const metaRef = db.ref(`chat_metadata/${convId}`);
        const existingMeta = await metaRef.once('value');
        const meta = existingMeta.val() || {
            title: userName,
            participants: { [currentUserId]: true, [userId]: true },
            createdBy: currentUserId,
            createdAt: Date.now(),
            lastMessage: '',
            lastTimestamp: Date.now(),
            avatar: allUsers[userId]?.foto_perfil || null
        };
        if (!existingMeta.exists()) await metaRef.set(meta);
        await db.ref(`chat_users/${currentUserId}/conversations/${convId}`).update({ ...meta, unreadCount: 0 });
        closeNewGroupModal();
        const sent = await sendGameChallengeToConversation(convId, meta.participants || participants, meta.title || userName);
        if (!sent) throw new Error('A mensagem do desafio não foi enviada.');
    } catch (error) {
        console.error('Não foi possível enviar o desafio ao contato:', error);
        alert(`Não foi possível enviar o desafio: ${error.message}`);
    }
}

function createConversationItem(convId, meta) {
    const item = document.createElement('div');
    item.className = 'conversation-item' + (convId === currentConvId ? ' active' : '');
    item.dataset.convId = convId;

    const rawParticipants = Array.isArray(meta.participants)
        ? meta.participants
        : Object.keys(meta.participants || {});
    const participantsArr = rawParticipants.filter(id =>
        id && id !== 'null' && id !== 'undefined' && id !== 'NaN'
    );
    const otherId = getOtherParticipantId(convId, participantsArr);
    const otherIds = otherId ? [otherId] : [];
    const contactIdFromTitle = Object.entries(allUsers).find(([userId, user]) => {
        const title = meta.title || meta.otherName;
        const userNames = [user.nome_usuario, user.nome_completo, user.handle]
            .filter(Boolean)
            .map(name => String(name).replace(/^@/, '').toLowerCase());
        return title
            && userId !== currentUserId
            && userNames.includes(String(title).replace(/^@/, '').toLowerCase());
    })?.[0];
    if (otherIds.length === 0 && contactIdFromTitle && contactIdFromTitle !== currentUserId) {
        otherIds.push(contactIdFromTitle);
        participantsArr.push(contactIdFromTitle);
    }

    const otherUser = otherIds.length === 1 ? allUsers[otherIds[0]] : null;
    const otherUserName = otherUser ? getParticipantDisplayName(otherUser, otherIds[0]) : null;
    const avatar = otherUser
        ? (otherUser.foto_perfil || null)
        : (meta.avatar || null);
    const metadataTitle = [meta.title, meta.otherName].find(value =>
        value && value !== 'undefined' && value !== 'null'
    );
    const title = otherId
        ? (otherUserName || otherId)
        : (metadataTitle || 'Conversa');
    const unread = Number(meta.unreadCount) || 0;

    const avatarElement = document.createElement('div');
    avatarElement.className = 'conv-avatar';
    const setAvatarFallback = () => {
        avatarElement.replaceChildren();
        const fallback = document.createElement('i');
        fallback.className = `fas fa-${otherIds.length === 1 ? 'user' : 'users'}`;
        avatarElement.appendChild(fallback);
    };
    if (avatar) {
        const image = document.createElement('img');
        image.src = avatar;
        image.alt = `Foto de perfil de ${title}`;
        image.addEventListener('error', setAvatarFallback, { once: true });
        avatarElement.appendChild(image);
    } else {
        setAvatarFallback();
    }

    const info = document.createElement('div');
    info.className = 'conv-info';
    const titleRow = document.createElement('div');
    titleRow.className = 'conv-title-row';
    const name = document.createElement('div');
    name.className = 'conv-name';
    name.textContent = title;
    titleRow.appendChild(name);
    if (unread > 0) {
        const badge = document.createElement('div');
        badge.className = 'conv-badge';
        badge.textContent = String(unread);
        titleRow.appendChild(badge);
    }
    const preview = document.createElement('div');
    preview.className = 'conv-last-msg';
    preview.textContent = meta.lastMessage || 'Sem mensagens';
    info.append(titleRow, preview);
    item.append(avatarElement, info);

    item.addEventListener('click', () => {
        openConversation(convId, participantsArr, title);
    });

    if (pendingBookChatInvite) {
        const inviteButton = document.createElement('button');
        inviteButton.type = 'button';
        inviteButton.className = 'send-book-invite';
        inviteButton.textContent = 'Enviar convite';
        inviteButton.addEventListener('click', async event => {
            event.stopPropagation();
            inviteButton.disabled = true;
            try {
                const sent = await sendBookInviteToConversation(convId, meta.participants || participantsArr, meta.title);
                if (!sent) inviteButton.disabled = false;
            } catch (error) {
                console.error('Não foi possível enviar o convite de leitura:', error);
                alert(`Não foi possível enviar o convite: ${error.message}`);
                inviteButton.disabled = false;
            }
        });
        item.appendChild(inviteButton);
    }
    if (pendingGameChallenge) {
        const challengeButton = document.createElement('button');
        challengeButton.type = 'button';
        challengeButton.className = 'send-game-challenge';
        challengeButton.textContent = 'Enviar desafio';
        challengeButton.addEventListener('click', async event => {
            event.stopPropagation();
            challengeButton.disabled = true;
            try {
                const sent = await sendGameChallengeToConversation(convId, meta.participants || participantsArr, meta.title);
                if (!sent) challengeButton.disabled = false;
            } catch (error) {
                console.error('Não foi possível enviar o desafio do jogo:', error);
                alert(`Não foi possível enviar o desafio: ${error.message}`);
                challengeButton.disabled = false;
            }
        });
        item.appendChild(challengeButton);
    }
    if (pendingFeedPostShare) {
        const shareButton = document.createElement('button');
        shareButton.type = 'button';
        shareButton.className = 'send-feed-post-share';
        shareButton.textContent = 'Enviar publicação';
        shareButton.addEventListener('click', async event => {
            event.stopPropagation();
            shareButton.disabled = true;
            try {
                const sent = await sendFeedPostToConversation(convId, meta.participants || participantsArr, title);
                if (!sent) shareButton.disabled = false;
            } catch (error) {
                console.error('Não foi possível compartilhar a publicação na conversa:', error);
                alert(`Não foi possível compartilhar a publicação: ${error.message}`);
                shareButton.disabled = false;
            }
        });
        item.appendChild(shareButton);
    }
    return item;
}

// ===== FCM: registro de service worker e token =====
async function registerFcmAndSaveToken() {
    if (!('serviceWorker' in navigator) || !('Notification' in window) || !firebase.messaging) {
        throw new Error('Este navegador não oferece suporte a notificações push.');
    }
    if (Notification.permission !== 'granted') {
        updateNotificationsButton();
        return false;
    }

    const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    await navigator.serviceWorker.ready;
    const messaging = firebase.messaging();
    const vapidKey = [window.FCM_VAPID_KEY, window.POEFO_FCM_VAPID_KEY]
        .find(key => key && !key.startsWith('COLOQUE_SUA_'));
    if (vapidKey && typeof messaging.usePublicVapidKey === 'function') {
        messaging.usePublicVapidKey(vapidKey);
    }

    const tokenOptions = { serviceWorkerRegistration: registration };
    if (vapidKey) tokenOptions.vapidKey = vapidKey;
    const currentToken = await messaging.getToken(tokenOptions);
    if (!currentToken) {
        throw new Error('O Firebase não retornou um token push. Confira a configuração Web Push/VAPID.');
    }
    if (!currentUserId) {
        throw new Error('Não foi possível identificar seu perfil para salvar o token push.');
    }

    await db.ref(`usuarios/${currentUserId}/fcmToken`).set(currentToken);
    sessionStorage.setItem('chatFcmTokenReady', 'true');
    updateNotificationsButton();

    if (!foregroundMessagingListenerRegistered) {
        messaging.onMessage(payload => {
            const data = payload.data || {};
            const notification = payload.notification || {};
            const convId = data.convId || '';
            if (!convId) return;
            notifyIncomingMessage(
                convId,
                data.title || notification.title || 'Nova mensagem',
                data.body || notification.body || '',
                data.icon || notification.icon || '/images/ic_chat.png',
                data.messageId || ''
            );
        });
        foregroundMessagingListenerRegistered = true;
    }

    return true;
}

// ===== UI FUNCTIONS =====
function toggleSidebar() {
    document.querySelector('.conversations-sidebar').classList.toggle('open');
}

async function openSelectedUserProfile() {
    if (!currentConvId || currentParticipants.length === 0) return alert('Nenhuma conversa selecionada');
    const otherId = currentParticipants.find(id => id !== currentUserId);
    if (!otherId) return;
    sessionStorage.setItem('viewUserId', otherId);
    window.location.href = '/perfil-usuario';
}

function showCallOptions() {
    alert('Funcionalidade de chamada em desenvolvimento');
}

function showChatInfo() {
    alert(`Conversa: ${document.getElementById('header-name').textContent}\nParticipantes: ${currentParticipants.length}`);
}

function getBookCatalog() {
    if (!bookCatalogPromise) {
        bookCatalogPromise = (async () => {
            const urls = [
                window.POEFO_FIREBASE_URLS?.allBooksDataUrl,
                '../base_dados/livros.json'
            ].filter(Boolean);
            let lastError;
            for (const url of urls) {
                try {
                    const response = await fetch(url);
                    if (!response.ok) throw new Error(`Falha ao carregar o catálogo (${response.status}).`);
                    const data = await response.json();
                    const books = Array.isArray(data) ? data : Object.values(data || {});
                    return books.filter(book => book && (book.titulo || book.title));
                } catch (error) {
                    lastError = error;
                }
            }
            throw lastError || new Error('O catálogo de livros não está disponível.');
        })().catch(error => {
            bookCatalogPromise = null;
            throw error;
        });
    }
    return bookCatalogPromise;
}

function normalizeBookClub(book) {
    if (!book) return null;
    const title = String(book.titulo || book.title || '').trim();
    if (!title) throw new Error('Este livro não possui um título válido.');
    return {
        id: String(book.id ?? book.bookId ?? title),
        titulo: title,
        autor: String(book.autor || book.author || '').trim(),
        link_capa: String(book.link_capa || book.coverUrl || ''),
        link_acesso: String(book.link_acesso || book.readUrl || '')
    };
}

function renderBookClubBooks(books) {
    const list = document.getElementById('book-club-books');
    const query = document.getElementById('book-club-search').value.trim().toLocaleLowerCase('pt-BR');
    const filtered = books.filter(book =>
        `${book.titulo || book.title || ''} ${book.autor || book.author || ''}`
            .toLocaleLowerCase('pt-BR').includes(query)
    ).slice(0, 80);
    list.replaceChildren();

    filtered.forEach(book => {
        const normalized = normalizeBookClub(book);
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'book-club-option' + (selectedBookClub?.id === normalized.id ? ' selected' : '');
        item.setAttribute('aria-pressed', String(selectedBookClub?.id === normalized.id));
        const cover = document.createElement('img');
        cover.src = normalized.link_capa || '../images/Logo_Poefo.png';
        cover.alt = '';
        cover.loading = 'lazy';
        const details = document.createElement('span');
        details.className = 'book-club-option-info';
        const title = document.createElement('strong');
        title.textContent = normalized.titulo;
        const author = document.createElement('small');
        author.textContent = normalized.autor || 'Autor não informado';
        details.append(title, author);
        const icon = document.createElement('i');
        icon.className = 'fas fa-check-circle';
        item.append(cover, details, icon);
        item.addEventListener('click', () => {
            selectedBookClub = normalized;
            renderBookClubBooks(books);
            renderBookClubSelection();
        });
        list.appendChild(item);
    });

    if (!filtered.length) {
        const empty = document.createElement('p');
        empty.className = 'book-club-empty';
        empty.textContent = query ? 'Nenhum livro encontrado.' : 'Nenhum livro disponível no catálogo.';
        list.appendChild(empty);
    }
}

function renderBookClubSelection() {
    const selection = document.getElementById('book-club-selection');
    document.getElementById('save-book-club').disabled = !selectedBookClub;
    selection.replaceChildren();
    if (!selectedBookClub) return;
    const label = document.createElement('span');
    label.className = 'book-club-selected-label';
    label.innerHTML = '<i class="fas fa-star"></i>';
    label.appendChild(document.createTextNode(` Selecionado: ${selectedBookClub.titulo}`));
    selection.appendChild(label);
}

async function openBookClubPicker() {
    if (!currentConvId) {
        alert('Selecione uma conversa ou crie um grupo antes de adicionar um livro.');
        return;
    }
    selectedBookClub = conversationBookClub ? { ...conversationBookClub } : null;
    document.getElementById('book-club-search').value = '';
    document.getElementById('book-club-selection').replaceChildren();
    document.getElementById('save-book-club').disabled = !selectedBookClub;
    document.getElementById('book-club-books').innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i></div>';
    document.getElementById('remove-book-club').hidden = !conversationBookClub;
    document.getElementById('book-club-modal').classList.add('active');
    try {
        const books = await getBookCatalog();
        renderBookClubBooks(books);
        renderBookClubSelection();
    } catch (error) {
        console.error('Não foi possível carregar os livros para o clube:', error);
        const list = document.getElementById('book-club-books');
        list.replaceChildren();
        const message = document.createElement('p');
        message.className = 'book-club-empty book-club-error';
        message.textContent = 'Não foi possível carregar os livros. Verifique sua conexão e tente novamente.';
        list.appendChild(message);
    }
}

function closeBookClubPicker() {
    document.getElementById('book-club-modal').classList.remove('active');
}

async function saveBookClubSelection(book = selectedBookClub) {
    if (!currentConvId) return;
    let normalized;
    try {
        normalized = normalizeBookClub(book);
    } catch (error) {
        alert(error.message);
        return;
    }
    const saveButton = document.getElementById('save-book-club');
    const removeButton = document.getElementById('remove-book-club');
    saveButton.disabled = true;
    removeButton.disabled = true;
    try {
        const convId = currentConvId;
        const metaRef = db.ref(`chat_metadata/${convId}`);
        const snapshot = await metaRef.once('value');
        if (!snapshot.exists()) throw new Error('Não foi possível encontrar os dados desta conversa.');
        await metaRef.update({ bookClub: normalized });
        await db.ref(`chat_users/${currentUserId}/conversations/${convId}`).update({ bookClub: normalized });
        if (currentConvId !== convId) {
            closeBookClubPicker();
            return;
        }
        conversationBookClub = normalized;
        renderBookClubPanel(normalized);
        closeBookClubPicker();
    } catch (error) {
        console.error('Não foi possível atualizar o livro do clube:', error);
        alert(`Não foi possível atualizar o livro do clube: ${error.message}`);
    } finally {
        saveButton.disabled = false;
        removeButton.disabled = false;
    }
}

function renderBookClubPanel(book) {
    const panel = document.getElementById('book-club-panel');
    panel.replaceChildren();
    panel.hidden = !book;
    if (!book) return;

    const cover = document.createElement('img');
    cover.className = 'book-club-cover';
    cover.src = book.link_capa || '../images/Logo_Poefo.png';
    cover.alt = `Capa de ${book.titulo}`;
    const copy = document.createElement('div');
    copy.className = 'book-club-copy';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'book-club-eyebrow';
    eyebrow.innerHTML = '<i class="fas fa-users"></i> CLUBE DE LEITURA';
    const title = document.createElement('strong');
    title.textContent = book.titulo;
    const author = document.createElement('small');
    author.textContent = book.autor || 'Leiam juntos e compartilhem suas impressões';
    copy.append(eyebrow, title, author);
    const actions = document.createElement('div');
    actions.className = 'book-club-panel-actions';
    if (book.link_acesso) {
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'book-club-open';
        open.innerHTML = '<i class="fas fa-book-open"></i> Ler';
        open.addEventListener('click', () => {
            sessionStorage.setItem('selectedBook', JSON.stringify(book));
            window.location.href = '/livro';
        });
        actions.appendChild(open);
    }
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'book-club-edit';
    edit.setAttribute('aria-label', 'Alterar livro do clube');
    edit.title = 'Alterar livro do clube';
    edit.innerHTML = '<i class="fas fa-pen"></i>';
    edit.addEventListener('click', openBookClubPicker);
    actions.appendChild(edit);
    panel.append(cover, copy, actions);
}

function closeMobileConversation() {
    document.body.classList.remove('mobile-chat-open');
}

function openNewGroupModal() {
    selectedParticipantIds.clear();
    document.getElementById('group-name').value = '';
    document.getElementById('participant-search').value = '';
    updateGroupSelectionUI();
    document.getElementById('new-group-modal').classList.add('active');
    loadUsersForModal();
}

function closeNewGroupModal() {
    document.getElementById('new-group-modal').classList.remove('active');
}

function updateGroupSelectionUI() {
    const isSpecialMode = Boolean(pendingBookChatInvite || pendingGameChallenge || pendingFeedPostShare);
    const groupNameField = document.getElementById('group-name-field');
    const submitButton = document.getElementById('submit-new-conversation');
    groupNameField.hidden = isSpecialMode || selectedParticipantIds.size < 2;
    submitButton.hidden = isSpecialMode;
    submitButton.textContent = selectedParticipantIds.size > 1 ? 'Criar grupo' : 'Iniciar conversa';
}

async function loadUsersForModal() {
    const participantList = document.getElementById('participant-list');
    participantList.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i></div>';
    const users = await safeReadRef('usuarios') || {};
    allUsers = users;
    renderParticipantList(Object.entries(users).map(([id, u]) => ({
        id,
        name: u.nome_usuario || u.nome_completo || u.handle || id,
        avatar: u.foto_perfil || null
    })));
}

function renderParticipantList(users) {
    const participantList = document.getElementById('participant-list');
    const search = document.getElementById('participant-search').value.toLowerCase();
    const filtered = users.filter(u => u.id !== currentUserId && (u.name.toLowerCase().includes(search) || u.id.toLowerCase().includes(search)));
    participantList.innerHTML = '';

    filtered.slice(0, 100).forEach(user => {
        const item = document.createElement('div');
        item.className = 'participant-item';

        const avatar = document.createElement('div');
        avatar.className = 'participant-avatar';
        if (user.avatar) {
            const image = document.createElement('img');
            image.src = user.avatar;
            image.alt = `Foto de perfil de ${user.name}`;
            image.addEventListener('error', () => {
                avatar.replaceChildren();
                const fallback = document.createElement('i');
                fallback.className = 'fas fa-user';
                avatar.appendChild(fallback);
            }, { once: true });
            avatar.appendChild(image);
        } else {
            const fallback = document.createElement('i');
            fallback.className = 'fas fa-user';
            avatar.appendChild(fallback);
        }

        const info = document.createElement('div');
        info.className = 'participant-info';
        const name = document.createElement('div');
        name.className = 'participant-name';
        name.textContent = user.name;
        const username = document.createElement('div');
        username.className = 'participant-id';
        username.textContent = `@${user.id}`;
        info.append(name, username);

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'participant-checkbox';
        checkbox.dataset.userid = user.id;
        checkbox.value = user.id;
        checkbox.checked = selectedParticipantIds.has(user.id);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) selectedParticipantIds.add(user.id);
            else selectedParticipantIds.delete(user.id);
            item.classList.toggle('selected', checkbox.checked);
            updateGroupSelectionUI();
        });

        item.append(avatar, info, checkbox);
        item.classList.toggle('selected', checkbox.checked);
        item.addEventListener('click', event => {
            if (event.target.closest('input, button') || pendingBookChatInvite || pendingGameChallenge || pendingFeedPostShare) return;
            checkbox.checked = !checkbox.checked;
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        });

        if (pendingBookChatInvite) {
            const inviteButton = document.createElement('button');
            inviteButton.type = 'button';
            inviteButton.className = 'send-book-invite';
            inviteButton.textContent = 'Enviar convite';
            inviteButton.addEventListener('click', () => inviteBookToContact(user.id, user.name));
            item.appendChild(inviteButton);
        }
        if (pendingGameChallenge) {
            const challengeButton = document.createElement('button');
            challengeButton.type = 'button';
            challengeButton.className = 'send-game-challenge';
            challengeButton.textContent = 'Enviar desafio';
            challengeButton.addEventListener('click', () => challengeContact(user.id, user.name));
            item.appendChild(challengeButton);
        }
        if (pendingFeedPostShare) {
            const shareButton = document.createElement('button');
            shareButton.type = 'button';
            shareButton.className = 'send-feed-post-share';
            shareButton.textContent = 'Enviar publicação';
            shareButton.addEventListener('click', () => shareFeedPostToContact(user.id, user.name));
            item.appendChild(shareButton);
        }
        participantList.appendChild(item);
    });

    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state-text';
        empty.textContent = 'Nenhum usuário encontrado';
        participantList.appendChild(empty);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('participant-search').addEventListener('input', () => {
        const users = Object.entries(allUsers).map(([id, u]) => ({
            id,
            name: u.nome_usuario || u.nome_completo || u.handle || id,
            avatar: u.foto_perfil || null
        }));
        renderParticipantList(users);
    });
});

async function createNewGroup() {
    if (!currentUserId) {
        alert('Entre na sua conta para iniciar uma conversa.');
        return;
    }
    const selectedIds = Array.from(selectedParticipantIds);
    if (selectedIds.length < 1) return alert('Selecione pelo menos um usuário');
    
    const participantsArr = [currentUserId, ...selectedIds];
    const convId = getConvIdFromParticipants(participantsArr);
    const defaultTitle = selectedIds.length === 1 ?
        (allUsers[selectedIds[0]]?.nome_usuario || selectedIds[0]) : 
        `Grupo (${participantsArr.length} pessoas)`;
    const groupName = selectedIds.length > 1
        ? (document.getElementById('group-name').value.trim() || defaultTitle)
        : defaultTitle;
    const submitButton = document.getElementById('submit-new-conversation');
    
    try {
        submitButton.disabled = true;
        const participantsObj = {};
        participantsArr.forEach(uid => {
            participantsObj[uid] = true;
        });
        const metaRef = db.ref(`chat_metadata/${convId}`);
        const existing = await metaRef.once('value');
        let meta = existing.val();

        if (!existing.exists()) {
            meta = {
                title: groupName,
                participants: participantsObj,
                createdAt: Date.now(),
                createdBy: currentUserId,
                lastMessage: '',
                lastTimestamp: Date.now(),
                avatar: selectedIds.length === 1 ? allUsers[selectedIds[0]]?.foto_perfil || null : null
            };
            await metaRef.set(meta);
        }
        
        closeNewGroupModal();
        await db.ref(`chat_users/${currentUserId}/conversations/${convId}`).set({
            ...meta,
            unreadCount: 0
        });
        await loadConversations();
        await openConversation(convId, meta.participants || participantsArr, meta.title || groupName);
    } catch (err) {
        console.error('Erro criar grupo:', err);
        alert(`Não foi possível iniciar a conversa: ${err.message}`);
    } finally {
        submitButton.disabled = false;
    }
}

async function attachImage() {
    if (!currentConvId) {
        alert('Selecione uma conversa antes de enviar uma imagem.');
        return;
    }
    document.getElementById('image-input').click();
}

document.getElementById('image-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
        if (!file.type.startsWith('image/')) throw new Error('Selecione um arquivo de imagem válido.');
        await uploadChatMedia(file, currentConvId);
    } catch (err) {
        console.error('Erro upload imagem:', err);
        alert(`Não foi possível enviar a imagem: ${err.message}`);
    }
    e.target.value = '';
});

async function toggleAudioRecorder() {
    if (isRecording) {
        stopRecording();
    } else if (!isStartingRecording) {
        await startRecording();
    }
}

async function startRecording() {
    if (!currentConvId) {
        alert('Selecione uma conversa antes de gravar um áudio.');
        return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        alert('Este navegador não oferece suporte à gravação de áudio.');
        return;
    }

    isStartingRecording = true;
    try {
        recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recordingConvId = currentConvId;
        const supportedTypes = [
            'audio/webm;codecs=opus',
            'audio/ogg;codecs=opus',
            'audio/mp4',
            'audio/webm',
            'audio/ogg'
        ];
        const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
            ? supportedTypes.find(type => MediaRecorder.isTypeSupported(type))
            : '';
        mediaRecorder = mimeType
            ? new MediaRecorder(recordingStream, { mimeType })
            : new MediaRecorder(recordingStream);
        recordedChunks = [];
        mediaRecorder.ondataavailable = e => {
            if (e.data.size > 0) recordedChunks.push(e.data);
        };
        mediaRecorder.onstop = async () => {
            try {
                const type = mediaRecorder.mimeType || recordedChunks[0]?.type || 'audio/webm';
                const blob = new Blob(recordedChunks, { type });
                if (!blob.size) throw new Error('A gravação ficou vazia. Tente novamente.');
                const extension = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
                const audioFile = new File([blob], `audio_${Date.now()}.${extension}`, { type });
                await uploadChatMedia(audioFile, recordingConvId);
            } catch (err) {
                console.error('Erro upload áudio:', err);
                alert(`Não foi possível enviar o áudio: ${err.message}`);
            } finally {
                recordingStream?.getTracks().forEach(track => track.stop());
                recordingStream = null;
                recordingConvId = null;
                mediaRecorder = null;
                recordedChunks = [];
                setAudioRecordingUI(false);
            }
        };
        mediaRecorder.start();
        isRecording = true;
        setAudioRecordingUI(true);
    } catch (err) {
        console.error('Erro gravação:', err);
        recordingStream?.getTracks().forEach(track => track.stop());
        recordingStream = null;
        recordingConvId = null;
        alert(`Não foi possível acessar o microfone: ${err.message}`);
    } finally {
        isStartingRecording = false;
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        isRecording = false;
        document.getElementById('media-status').textContent = 'Preparando áudio para envio...';
        mediaRecorder.stop();
    }
}

function setAudioRecordingUI(recording) {
    isRecording = recording;
    const button = document.getElementById('audio-record-btn');
    const status = document.getElementById('media-status');
    button.classList.toggle('is-recording', recording);
    button.title = recording ? 'Parar e enviar áudio' : 'Gravar áudio';
    button.setAttribute('aria-label', button.title);
    button.innerHTML = recording
        ? '<i class="fas fa-stop-circle"></i>'
        : '<i class="fas fa-microphone"></i>';
    status.hidden = !recording;
    status.textContent = recording ? 'Gravando áudio... Toque novamente para enviar.' : '';
}

async function uploadChatMedia(file, convId) {
    if (!convId) throw new Error('Selecione uma conversa antes de enviar o arquivo.');
    if (!currentUserId) throw new Error('Entre na sua conta antes de enviar arquivos.');
    const authUser = firebase.auth().currentUser;
    if (!authUser) throw new Error('Sua sessão expirou. Entre novamente para enviar arquivos.');

    const status = document.getElementById('media-status');
    const imageButton = document.getElementById('image-attach-btn');
    const audioButton = document.getElementById('audio-record-btn');
    imageButton.disabled = true;
    audioButton.disabled = true;
    status.hidden = false;
    status.textContent = 'Enviando arquivo...';

    try {
        const extension = file.name.split('.').pop()?.toLowerCase() || '';
        const inferredType = {
            m4a: 'audio/mp4',
            mp3: 'audio/mpeg',
            mp4: 'audio/mp4',
            oga: 'audio/ogg',
            ogg: 'audio/ogg',
            opus: 'audio/ogg',
            wav: 'audio/wav',
            webm: 'audio/webm'
        }[extension] || '';
        const mediaType = (file.type || inferredType).split(';')[0].trim();
        if (!mediaType) throw new Error('Não foi possível identificar o formato do arquivo.');

        const safeName = file.name.replace(/[^\w.-]/g, '_');
        const path = `chat_media/${convId}/${authUser.uid}/${Date.now()}_${safeName}`;
        const fileRef = storage.ref().child(path);
        const snapshot = await fileRef.put(file, {
            contentType: mediaType,
            customMetadata: { conversationId: convId, senderId: currentUserId }
        });
        const url = await snapshot.ref.getDownloadURL();
        if (!url || !/^https?:\/\//i.test(url)) {
            throw new Error('O Firebase não retornou um link válido para o arquivo.');
        }
        const sent = await sendMessage('', url, mediaType, null, convId);
        if (!sent) {
            await snapshot.ref.delete();
            throw new Error('O arquivo foi enviado, mas a mensagem não pôde ser entregue.');
        }
    } finally {
        imageButton.disabled = false;
        audioButton.disabled = false;
        status.hidden = true;
        status.textContent = '';
    }
}

async function sendMessage(text = null, mediaUrl = null, mediaType = null, bookAttachment = null, targetConvId = currentConvId) {
    const inputEl = document.getElementById('message-input');
    text = text === null
        ? (inputEl ? inputEl.value.trim() : '')
        : String(text).trim();
    
    if (!text && !mediaUrl) {
        console.warn('Mensagem vazia');
        return false;
    }
    
    if (!targetConvId) {
        alert('Selecione uma conversa primeiro');
        return false;
    }
    
    const message = {
        userId: currentUserId,
        userName: currentUserName,
        text: text || '',
        mediaUrl: mediaUrl || null,
        mediaType: mediaType || null,
        timestamp: Date.now()
    };
    if (bookAttachment) message.bookAttachment = bookAttachment;
    
    try {
        console.log('=== DEBUG: Enviando Mensagem ===');
        console.log('ConvId:', targetConvId);
        console.log('UserId:', currentUserId);
        console.log('Caminho:', `chat/${targetConvId}/messages`);
        console.log('Mensagem:', message);
        
        // APENAS enviar mensagem - sem atualizar metadados
        await db.ref(`chat/${targetConvId}/messages`).push(message);
        
        // Limpar campo de input
        if (inputEl && !mediaUrl) inputEl.value = '';
        
        console.log('✓ Mensagem enviada com sucesso');
        
        // Atualizar metadados de forma assíncrona (sem bloquear envio)
        updateChatMetadata(targetConvId, text, mediaUrl, mediaType).catch(err => {
            console.warn('Não foi possível atualizar metadados:', err);
        });
        return true;
    } catch (err) {
        console.error('✗ ERRO ao enviar mensagem:', err);
        console.error('Código de erro:', err.code);
        console.error('Mensagem:', err.message);
        alert('Erro ao enviar mensagem: ' + err.message);
        return false;
    }
}

// Atualizar metadados da conversa de forma assíncrona
async function updateChatMetadata(convId, text, mediaUrl, mediaType) {
    try {
        const mediaLabel = mediaType?.startsWith('audio/')
            ? 'Áudio'
            : mediaType?.startsWith('image/')
                ? 'Imagem'
                : 'Arquivo';
        const preview = mediaUrl ? `[${mediaLabel}]` : text;
        await db.ref(`chat_users/${currentUserId}/conversations/${convId}`).update({
            lastMessage: preview,
            lastTimestamp: Date.now(),
            lastMessageSenderId: currentUserId,
            unreadCount: 0
        });
    } catch (err) {
        console.warn('Erro ao atualizar a conversa do remetente:', err);
    }
}

async function loadConversations() {
    const convList = document.getElementById('conversations-list');
    const previousOrder = Array.from(convList.children)
        .map(item => item.dataset.convId)
        .filter(Boolean);
    convList.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i></div>';
    
    const conversations = await safeReadRef(`chat_users/${currentUserId}/conversations`) || {};
    convList.innerHTML = '';

    if (Object.keys(conversations).length === 0) {
        convList.innerHTML = '<div style="padding: 16px; text-align: center; color: #65676b;">Sem conversas</div>';
        return;
    }

    const entries = getConversationEntries(conversations, previousOrder);

    entries.forEach(({ convId, meta }) => {
        convList.appendChild(createConversationItem(convId, meta));
    });
}

// Inscrever-se nas conversas do usuário para atualizações em tempo real
function subscribeConversations() {
    const ref = db.ref(`chat_users/${currentUserId}/conversations`);
    ref.off();
    let hasReceivedInitialSnapshot = false;
    ref.on('value', snap => {
        const data = snap.exists() ? snap.val() : {};
        const convList = document.getElementById('conversations-list');
        const previousOrder = Array.from(convList.children)
            .map(item => item.dataset.convId)
            .filter(Boolean);
        convList.innerHTML = '';
        Object.entries(data).forEach(([convId, meta]) => {
            const timestamp = Number(meta.lastTimestamp) || 0;
            const unreadCount = Number(meta.unreadCount) || 0;
            const previousTimestamp = notificationTimestamps.get(convId);
            const previousUnreadCount = notificationUnreadCounts.get(convId);
            const conversationVisible = isConversationVisible(convId);
            const isNewConversation = hasReceivedInitialSnapshot && previousTimestamp === undefined;
            const hasNewUnread = previousUnreadCount !== undefined && unreadCount > previousUnreadCount;
            const hasNewMessage = previousTimestamp !== undefined && timestamp > previousTimestamp;
            if (
                !conversationVisible
                && meta.lastMessage
                && meta.lastMessageSenderId !== currentUserId
                && (hasNewMessage || hasNewUnread || (isNewConversation && unreadCount > 0))
            ) {
                const participants = Array.isArray(meta.participants)
                    ? meta.participants
                    : Object.keys(meta.participants || {});
                const otherId = getOtherParticipantId(convId, participants);
                const otherUser = otherId ? allUsers[otherId] : null;
                notifyIncomingMessage(
                    convId,
                    otherUser ? getParticipantDisplayName(otherUser, otherId) : meta.title || 'Nova mensagem',
                    meta.lastMessage,
                    otherUser ? otherUser.foto_perfil || null : meta.avatar || null,
                    meta.lastMessageId || ''
                );
            }
            notificationTimestamps.set(convId, timestamp);
            notificationUnreadCounts.set(convId, unreadCount);
            if (conversationVisible && Number(meta.unreadCount) > 0) {
                db.ref(`chat_users/${currentUserId}/conversations/${convId}/unreadCount`)
                    .set(0)
                    .catch(error => console.error('Não foi possível zerar mensagens já lidas:', error));
            }
        });
        if (Object.keys(data).length === 0) {
            hasReceivedInitialSnapshot = true;
            convList.innerHTML = '<div style="padding: 16px; text-align: center; color: #65676b;">Sem conversas</div>';
            return;
        }

        const entries = getConversationEntries(data, previousOrder);
        entries.forEach(({ convId, meta }) => {
            const visibleMeta = isConversationVisible(convId)
                ? { ...meta, unreadCount: 0 }
                : meta;
            convList.appendChild(createConversationItem(convId, visibleMeta));
        });
        hasReceivedInitialSnapshot = true;
    });
}

async function openConversation(convId, participants, title) {
    if (activeMessagesQuery && activeMessageAddedHandler) {
        activeMessagesQuery.off('child_added', activeMessageAddedHandler);
    }
    if (activeMessagesRef && activeMessageRemovedHandler) {
        activeMessagesRef.off('child_removed', activeMessageRemovedHandler);
    }
    activeMessagesQuery = null;
    activeMessagesRef = null;
    activeMessageAddedHandler = null;
    activeMessageRemovedHandler = null;
    currentConvId = convId;
    conversationBookClub = null;
    renderBookClubPanel(null);
    document.body.classList.add('mobile-chat-open');
    
    // Converter participants para array se for objeto
    let participantsArray = Array.isArray(participants)
        ? participants 
        : Object.keys(participants || {});
    const inferredOtherId = getOtherParticipantId(convId, participantsArray);
    if (inferredOtherId && !participantsArray.includes(inferredOtherId)) {
        participantsArray = [...participantsArray, inferredOtherId];
    }
    currentParticipants = participantsArray;
    watchConversationPresence(participantsArray);
    
    // Mostrar área de mensagens e manter a barra de composição fixa em baixo
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('messages-area').style.display = 'flex';
    document.getElementById('compose-section').style.display = 'flex';
    updateChatViewportHeight();
    requestAnimationFrame(() => {
        const chatMain = document.querySelector('.chat-main');
        const messagesArea = document.getElementById('messages-area');
        if (chatMain && window.getComputedStyle(chatMain).display !== 'none') {
            messagesArea.scrollTop = messagesArea.scrollHeight;
        }
    });
    const otherId = getOtherParticipantId(convId, participantsArray);
    const otherUser = otherId ? allUsers[otherId] : null;
    const displayTitle = otherUser
        ? getParticipantDisplayName(otherUser, otherId)
        : title || participantsArray.join(', ');
    document.getElementById('header-name').textContent = displayTitle;
    try {
        const metadataSnapshot = await db.ref(`chat_metadata/${convId}`).once('value');
        if (currentConvId !== convId) return;
        conversationBookClub = metadataSnapshot.val()?.bookClub || null;
        renderBookClubPanel(conversationBookClub);
    } catch (error) {
        console.warn('Não foi possível carregar o livro do clube:', error);
    }
    
    // Atualizar avatares no header
    const avatarEl = document.getElementById('header-avatar');
    if (otherUser?.foto_perfil) {
        avatarEl.innerHTML = `<img src="${otherUser.foto_perfil}" alt="avatar">`;
    } else {
        avatarEl.innerHTML = '<i class="fas fa-user"></i>';
    }
    
    // Atualizar sidebar - marcar conversa como ativa
    document.querySelectorAll('.conversation-item').forEach(el => el.classList.remove('active'));
    const activeItem = document.querySelector(`.conversation-item[data-conv-id="${convId}"]`);
    if (activeItem) {
        activeItem.classList.add('active');
    }
    
    // Carregar mensagens
    const messagesArea = document.getElementById('messages-area');
    messagesArea.innerHTML = '';
    
    const messagesRef = db.ref(`chat/${convId}/messages`);
    
    // Limpar e recarregar
    const snapshot = await messagesRef.limitToLast(200).once('value');
    if (currentConvId !== convId) return;
    const messagesQuery = messagesRef.limitToLast(1);
    const renderedMessageIds = new Set();
    if (snapshot.exists()) {
        const msgs = [];
        snapshot.forEach(child => {
            msgs.push({ id: child.key, message: child.val() });
        });
        msgs.sort((a, b) => a.message.timestamp - b.message.timestamp);
        msgs.forEach(({ id, message }) => {
            renderedMessageIds.add(id);
            renderMessage(message, messagesArea, id, convId);
        });
    }
    
    // Listener para novas mensagens
    const messageAddedHandler = snap => {
        if (currentConvId !== convId || activeMessagesQuery !== messagesQuery) return;
        const msg = snap.val();
        if (msg && !renderedMessageIds.has(snap.key)) {
            renderedMessageIds.add(snap.key);
            renderMessage(msg, messagesArea, snap.key, convId);
            if (msg.userId !== currentUserId && isConversationVisible(convId)) {
                db.ref(`chat_users/${currentUserId}/conversations/${convId}/unreadCount`)
                    .set(0)
                    .catch(error => console.error('Não foi possível marcar a mensagem como lida:', error));
            }
        }
    };
    const messageRemovedHandler = snap => {
        if (currentConvId !== convId || activeMessagesRef !== messagesRef) return;
        const messageElement = Array.from(messagesArea.children)
            .find(element => element.dataset.messageId === snap.key);
        messageElement?.remove();
    };
    activeMessagesRef = messagesRef;
    activeMessagesQuery = messagesQuery;
    activeMessageAddedHandler = messageAddedHandler;
    activeMessageRemovedHandler = messageRemovedHandler;
    messagesQuery.on('child_added', messageAddedHandler);
    messagesRef.on('child_removed', messageRemovedHandler);
    // Zerar contador de não lidas para esta conversa ao abrir
    try {
        db.ref(`chat_users/${currentUserId}/conversations/${convId}/unreadCount`).set(0);
    } catch (e) { /* ignore */ }
    
    messagesArea.scrollTop = messagesArea.scrollHeight;
}

function renderMessage(msg, container, messageId, convId) {
    const div = document.createElement('div');
    const isSent = msg.userId === currentUserId;
    div.className = 'message ' + (isSent ? 'sent' : 'received');
    div.dataset.messageId = messageId;
    div.dataset.conversationId = convId;
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    if (msg.text) {
        const text = document.createElement('div');
        text.textContent = msg.text;
        bubble.appendChild(text);
    }

    const rawMediaUrl = msg.mediaUrl || msg.mediaURL || msg.audioUrl || msg.fileUrl || '';
    const rawMediaPath = msg.mediaPath || msg.storagePath || '';
    const mediaReference = rawMediaUrl || rawMediaPath;
    if (mediaReference) {
        const inferredPath = `${rawMediaUrl} ${rawMediaPath}`.toLowerCase();
        const mediaType = String(msg.mediaType || msg.mimeType || '').split(';')[0].trim().toLowerCase()
            || (/\.(mp3)(?:[?#\s]|$)/i.test(inferredPath) ? 'audio/mpeg' : '')
            || (/\.(m4a|mp4)(?:[?#\s]|$)/i.test(inferredPath) ? 'audio/mp4' : '')
            || (/\.(ogg|oga|opus)(?:[?#\s]|$)/i.test(inferredPath) ? 'audio/ogg' : '')
            || (/\.(wav)(?:[?#\s]|$)/i.test(inferredPath) ? 'audio/wav' : '')
            || (/\.(webm)(?:[?#\s]|$)/i.test(inferredPath) ? 'audio/webm' : '');
        const media = mediaType.startsWith('image/')
            ? document.createElement('img')
            : mediaType.startsWith('audio/')
                ? document.createElement('audio')
                : mediaType.startsWith('video/')
                    ? document.createElement('video')
                    : null;
        if (media) {
            media.className = 'message-media';
            if (media instanceof HTMLImageElement) {
                media.src = rawMediaUrl;
                media.alt = 'Imagem enviada';
                media.loading = 'lazy';
            } else {
                media.controls = true;
                media.preload = 'metadata';
                media.setAttribute('playsinline', '');
            }
            if (media instanceof HTMLAudioElement) {
                media.controls = false;
                media.classList.add('audio-source-hidden');
                const player = document.createElement('div');
                player.className = 'audio-player-shell';
                const audioIcon = document.createElement('span');
                audioIcon.className = 'audio-player-icon';
                audioIcon.innerHTML = '<i class="fas fa-headphones"></i>';
                const audioContent = document.createElement('div');
                audioContent.className = 'audio-player-content';
                const audioTitle = document.createElement('span');
                audioTitle.className = 'audio-player-title';
                audioTitle.textContent = isSent ? 'Áudio enviado' : `Áudio de ${msg.userName || 'contato'}`;
                const playButton = document.createElement('button');
                playButton.type = 'button';
                playButton.className = 'audio-play-button';
                playButton.setAttribute('aria-label', 'Reproduzir áudio');
                playButton.innerHTML = '<i class="fas fa-play"></i>';
                const seek = document.createElement('input');
                seek.type = 'range';
                seek.className = 'audio-seek';
                seek.min = '0';
                seek.max = '1000';
                seek.value = '0';
                seek.setAttribute('aria-label', 'Progresso do áudio');
                const currentTime = document.createElement('span');
                currentTime.className = 'audio-time';
                currentTime.textContent = '0:00';
                const duration = document.createElement('span');
                duration.className = 'audio-time audio-duration';
                duration.textContent = '--:--';
                const audioError = document.createElement('span');
                audioError.className = 'audio-player-error';
                audioError.hidden = true;
                audioError.textContent = 'Não foi possível reproduzir este áudio.';
                const formatAudioTime = seconds => {
                    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
                    const minutes = Math.floor(seconds / 60);
                    const remainingSeconds = Math.floor(seconds % 60);
                    return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
                };
                const updateProgress = () => {
                    const total = media.duration;
                    const played = Number.isFinite(total) && total > 0
                        ? Math.min(1000, Math.round((media.currentTime / total) * 1000))
                        : 0;
                    seek.value = String(played);
                    seek.style.setProperty('--audio-progress', `${played / 10}%`);
                    currentTime.textContent = formatAudioTime(media.currentTime);
                    duration.textContent = formatAudioTime(total);
                };
                const updatePlaybackState = () => {
                    const playing = !media.paused && !media.ended;
                    player.classList.toggle('is-playing', playing);
                    playButton.setAttribute('aria-label', playing ? 'Pausar áudio' : 'Reproduzir áudio');
                    playButton.innerHTML = playing
                        ? '<i class="fas fa-pause"></i>'
                        : '<i class="fas fa-play"></i>';
                };
                playButton.addEventListener('click', async () => {
                    if (media.paused) {
                        try {
                            await media.play();
                        } catch (error) {
                            console.error('Não foi possível reproduzir o áudio:', error);
                            audioError.hidden = false;
                        }
                    } else {
                        media.pause();
                    }
                });
                seek.addEventListener('input', () => {
                    seek.style.setProperty('--audio-progress', `${Number(seek.value) / 10}%`);
                    if (Number.isFinite(media.duration) && media.duration > 0) {
                        const targetTime = (Number(seek.value) / 1000) * media.duration;
                        currentTime.textContent = formatAudioTime(targetTime);
                    }
                });
                seek.addEventListener('change', () => {
                    if (Number.isFinite(media.duration) && media.duration > 0) {
                        media.currentTime = (Number(seek.value) / 1000) * media.duration;
                    }
                });
                const wave = document.createElement('span');
                wave.className = 'audio-waveform';
                wave.setAttribute('aria-hidden', 'true');
                for (let i = 0; i < 20; i += 1) {
                    const bar = document.createElement('i');
                    bar.style.height = `${[6, 10, 14, 8, 12][i % 5]}px`;
                    bar.style.animationDelay = `${-i * 35}ms`;
                    wave.appendChild(bar);
                }
                const audioTopRow = document.createElement('div');
                audioTopRow.className = 'audio-top-row';
                const audioVisual = document.createElement('div');
                audioVisual.className = 'audio-visual';
                audioVisual.append(wave, playButton);
                audioTopRow.append(audioTitle, audioVisual);
                const controls = document.createElement('div');
                controls.className = 'audio-custom-controls';
                controls.append(currentTime, seek, duration);
                audioContent.append(audioTopRow, controls, media, audioError);
                const openAudio = document.createElement('a');
                openAudio.className = 'audio-open-link';
                openAudio.target = '_blank';
                openAudio.rel = 'noopener noreferrer';
                openAudio.textContent = 'Abrir áudio';
                openAudio.hidden = true;
                audioContent.appendChild(openAudio);
                player.append(audioIcon, audioContent);
                media.addEventListener('play', updatePlaybackState);
                media.addEventListener('pause', updatePlaybackState);
                media.addEventListener('ended', () => {
                    updatePlaybackState();
                    updateProgress();
                });
                media.addEventListener('timeupdate', updateProgress);
                media.addEventListener('loadedmetadata', updateProgress);
                media.addEventListener('durationchange', updateProgress);
                media.addEventListener('error', () => {
                    player.classList.remove('is-playing');
                    updatePlaybackState();
                    audioError.hidden = false;
                    openAudio.hidden = !media.currentSrc;
                });
                media.addEventListener('loadedmetadata', () => {
                    audioError.hidden = true;
                    openAudio.hidden = true;
                });
                const setAudioSource = url => {
                    if (!url) throw new Error('A mensagem não contém um link de áudio.');
                    media.src = url;
                    openAudio.href = url;
                    media.load();
                };
                const isHttpUrl = /^https?:\/\//i.test(rawMediaUrl);
                if (isHttpUrl) {
                    setAudioSource(rawMediaUrl);
                } else {
                    const mediaRef = rawMediaUrl.startsWith('gs://')
                        ? storage.refFromURL(rawMediaUrl)
                        : storage.ref(rawMediaPath || rawMediaUrl);
                    mediaRef.getDownloadURL().then(setAudioSource).catch(error => {
                        console.error('Não foi possível obter o link de reprodução do áudio:', error);
                        audioError.hidden = false;
                    });
                }
                bubble.appendChild(player);
            } else {
                media.src = rawMediaUrl;
                bubble.appendChild(media);
            }
        }
    } else if (String(msg.mediaType || msg.mimeType || '').toLowerCase().startsWith('audio/')) {
        const unavailable = document.createElement('div');
        unavailable.className = 'audio-link-unavailable';
        unavailable.textContent = 'O link deste áudio não está disponível na mensagem.';
        bubble.appendChild(unavailable);
    }

    div.appendChild(bubble);
    const footer = document.createElement('div');
    footer.className = 'message-footer';
    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = timeAgo(msg.timestamp);
    footer.appendChild(time);
    if (isSent) {
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'message-delete-btn';
        deleteButton.title = 'Apagar mensagem';
        deleteButton.setAttribute('aria-label', 'Apagar minha mensagem');
        deleteButton.innerHTML = '<i class="fas fa-trash-alt" aria-hidden="true"></i>';
        deleteButton.addEventListener('click', () => deleteChatMessage(
            div.dataset.conversationId,
            div.dataset.messageId,
            div,
            deleteButton
        ));
        footer.appendChild(deleteButton);
    }
    div.appendChild(footer);
    if (msg.bookAttachment) {
        const book = msg.bookAttachment;
        const card = document.createElement('div');
        card.className = 'book-invite-card';
        const cover = document.createElement('img');
        cover.src = book.link_capa || '../images/Logo_Poefo.png';
        cover.alt = '';
        const details = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = book.titulo || 'Livro';
        const openButton = document.createElement('button');
        openButton.type = 'button';
        openButton.textContent = 'Ver livro';
        openButton.addEventListener('click', () => {
            sessionStorage.setItem('selectedBook', JSON.stringify(book));
            window.location.href = '/livro';
        });
        details.append(title, openButton);
        card.append(cover, details);
        div.querySelector('.message-bubble').appendChild(card);
    }
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

async function deleteChatMessage(convId, messageId, messageElement, button) {
    if (!window.confirm('Deseja apagar esta mensagem? Esta ação não pode ser desfeita.')) return;

    button.disabled = true;
    try {
        const auth = firebase.auth();
        const authUser = auth.currentUser || await new Promise(resolve => {
            let unsubscribe = () => {};
            unsubscribe = auth.onAuthStateChanged(user => {
                unsubscribe();
                resolve(user);
            });
        });
        if (!authUser) throw new Error('Sua sessão expirou. Entre novamente para apagar a mensagem.');
        const deleteMessage = firebase.functions().httpsCallable('deleteChatMessage');
        await deleteMessage({ profileId: currentUserId, convId, msgId: messageId });
        messageElement.remove();
    } catch (error) {
        console.error('Não foi possível apagar a mensagem:', error);
        alert(`Não foi possível apagar a mensagem: ${error.message || 'tente novamente.'}`);
        button.disabled = false;
    }
}

function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('book-club-search')?.addEventListener('input', async () => {
        try {
            renderBookClubBooks(await getBookCatalog());
        } catch (error) {
            console.warn('Não foi possível filtrar o catálogo do clube:', error);
        }
    });

    document.getElementById('book-club-modal')?.addEventListener('click', event => {
        if (event.target.id === 'book-club-modal') closeBookClubPicker();
    });

    const authUser = await new Promise(resolve => {
        let unsubscribe = () => {};
        unsubscribe = firebase.auth().onAuthStateChanged(user => {
            unsubscribe();
            resolve(user);
        });
    });
    if (!authUser) {
        window.location.replace('/login');
        return;
    }

    const profile = await PoefoAuthProfile.findByAuthUid(authUser.uid);
    if (!profile || profile.data.bloqueado === true) {
        await firebase.auth().signOut();
        window.location.replace('/login');
        return;
    }
    PoefoAuthProfile.saveSession(profile, authUser);
    currentUserId = profile.id;
    currentUserName = profile.data.nome_usuario || profile.data.nome_completo || currentUserName;
    currentUserAvatar = profile.data.foto_perfil || currentUserAvatar;
    const storedSilentMode = localStorage.getItem(`chatSilentMode:${currentUserId}`);
    chatSilentMode = typeof profile.data.chatSilentMode === 'boolean'
        ? profile.data.chatSilentMode
        : storedSilentMode === 'true';
    startPresenceTracking();

    document.getElementById('mobile-chat-back')?.addEventListener('click', closeMobileConversation);
    document.getElementById('chat-notifications-toggle')?.addEventListener('click', enableChatNotifications);

    // Carregar usuários primeiro
    allUsers = (await safeReadRef('usuarios')) || {};
    const pendingBookInviteJson = sessionStorage.getItem('pendingBookChatInvite');
    if (pendingBookInviteJson) {
        try {
            pendingBookChatInvite = JSON.parse(pendingBookInviteJson);
            if (!pendingBookChatInvite || !pendingBookChatInvite.id) {
                throw new Error('Dados do livro inválidos.');
            }
            const invitePrompt = document.getElementById('book-invite-prompt');
            if (invitePrompt) invitePrompt.style.display = 'block';
            document.body.classList.add('book-invite-mode');
        } catch (error) {
            console.error('Não foi possível carregar o convite de leitura:', error);
            alert('Não foi possível carregar os dados do livro para o convite.');
            sessionStorage.removeItem('pendingBookChatInvite');
        }
    }

    document.getElementById('find-book-invite-contact')?.addEventListener('click', openNewGroupModal);
    document.getElementById('cancel-book-invite')?.addEventListener('click', () => {
        pendingBookChatInvite = null;
        sessionStorage.removeItem('pendingBookChatInvite');
        document.getElementById('book-invite-prompt').style.display = 'none';
        document.body.classList.remove('book-invite-mode');
        loadConversations();
    });
    
    const pendingChallenge = sessionStorage.getItem('pendingGameChallenge');
    if (pendingChallenge) {
        try {
            const parsed = JSON.parse(pendingChallenge);
            if (parsed.recipientId) {
                sessionStorage.setItem('chatWithUserId', parsed.recipientId);
                sessionStorage.setItem('chatWithUserName', parsed.recipientName || '');
                sessionStorage.setItem('pendingGameChallengeText', parsed.text || '');
                sessionStorage.removeItem('pendingGameChallenge');
            } else if (parsed.gameName && parsed.text) {
                pendingGameChallenge = parsed;
                const challengePrompt = document.getElementById('game-challenge-prompt');
                if (challengePrompt) challengePrompt.style.display = 'block';
                document.body.classList.add('game-challenge-mode');
            } else {
                throw new Error('Dados do desafio inválidos.');
            }
        } catch (error) {
            console.error('Não foi possível carregar o desafio do jogo:', error);
            alert('Não foi possível carregar os dados do desafio.');
            sessionStorage.removeItem('pendingGameChallenge');
        }
    }

    document.getElementById('find-game-challenge-contact')?.addEventListener('click', openNewGroupModal);
    document.getElementById('cancel-game-challenge')?.addEventListener('click', () => {
        pendingGameChallenge = null;
        sessionStorage.removeItem('pendingGameChallenge');
        document.getElementById('game-challenge-prompt').style.display = 'none';
        document.body.classList.remove('game-challenge-mode');
        loadConversations();
    });

    const pendingFeedPost = sessionStorage.getItem('pendingFeedPostShare');
    if (pendingFeedPost) {
        try {
            pendingFeedPostShare = JSON.parse(pendingFeedPost);
            if (!pendingFeedPostShare?.postId) throw new Error('Dados da publicação inválidos.');
            const prompt = document.getElementById('feed-post-share-prompt');
            if (prompt) prompt.style.display = 'block';
            document.body.classList.add('feed-post-share-mode');
        } catch (error) {
            console.error('Não foi possível carregar a publicação para compartilhar:', error);
            alert('Não foi possível carregar os dados da publicação.');
            sessionStorage.removeItem('pendingFeedPostShare');
        }
    }
    document.getElementById('find-feed-post-contact')?.addEventListener('click', openNewGroupModal);
    document.getElementById('cancel-feed-post-share')?.addEventListener('click', () => {
        pendingFeedPostShare = null;
        sessionStorage.removeItem('pendingFeedPostShare');
        document.getElementById('feed-post-share-prompt').style.display = 'none';
        document.body.classList.remove('feed-post-share-mode');
        loadConversations();
    });

    // Se aberto de um clique em "Mensagem" do visualizador
    const preOther = sessionStorage.getItem('chatWithUserId');
    const preOtherName = sessionStorage.getItem('chatWithUserName');
    
        if (preOther) {
        // Se vindo do visualizador, criar conversa antes de carregar lista
        const participants = [currentUserId, preOther];
        const convId = getConvIdFromParticipants(participants);
        
        // Buscar dados do outro usuário
        const otherUserData = allUsers[preOther] || {};
        const finalName = preOtherName || otherUserData.nome_usuario || otherUserData.nome_completo || preOther;
        
        // Converter participants para objeto (requerido pelas regras de segurança)
        const participantsObj = {};
        participants.forEach(uid => participantsObj[uid] = true);
        
        // Criar/atualizar entry se não existir
        const proposedMeta = {
            title: finalName,
            participants: participantsObj,
            createdBy: currentUserId,
            createdAt: Date.now(),
            lastMessage: '',
            lastTimestamp: Date.now(),
            avatar: otherUserData.foto_perfil || null
        };
        
        try {
            const metaRef = db.ref(`chat_metadata/${convId}`);
            const existingMeta = await metaRef.once('value');
            const meta = existingMeta.val() || proposedMeta;
            if (!existingMeta.exists()) await metaRef.set(meta);
            // Adicionar apenas para o usuário autenticado
            await db.ref(`chat_users/${currentUserId}/conversations/${convId}`).set({ ...meta, unreadCount: 0 });
            // O outro usuário verá a conversa quando abrir o chat (síncrona via listeners)
        } catch (err) {
            console.warn('Erro ao criar conversa inicial:', err);
        }
        
        // Carregar conversas (que agora incluirá a nova)
            // Inscrever e carregar conversas (agora incluirá a nova)
            subscribeConversations();
        
        // Abrir a conversa selecionada
        openConversation(convId, participants, finalName);
        
        const challengeText = sessionStorage.getItem('pendingGameChallengeText');
        if (challengeText) {
            setTimeout(() => {
                sendMessage(challengeText);
            }, 900);
            sessionStorage.removeItem('pendingGameChallengeText');
        }

        // Limpar sessionStorage
        sessionStorage.removeItem('chatWithUserId');
        sessionStorage.removeItem('chatWithUserName');
    } else {
        // Se não vindo do visualizador, inscrever e carregar conversas em tempo real
        subscribeConversations();
    }

    const notificationConversationId = new URLSearchParams(window.location.search).get('conversation');
    if (!preOther && notificationConversationId) {
        const conversationSnapshot = await db.ref(
            `chat_users/${currentUserId}/conversations/${notificationConversationId}`
        ).once('value');
        const conversation = conversationSnapshot.val();
        if (conversation) {
            const participants = Array.isArray(conversation.participants)
                ? conversation.participants
                : Object.keys(conversation.participants || {});
            await openConversation(
                notificationConversationId,
                participants,
                conversation.title || conversation.otherName
            );
        }
    }
    
    // Search
    document.getElementById('search-convs')?.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        document.querySelectorAll('.conversation-item').forEach(item => {
            const name = item.querySelector('.conv-name').textContent.toLowerCase();
            item.style.display = name.includes(query) ? '' : 'none';
        });
    });
    
    // Enviar mensagem ao clicar botao
    document.getElementById('send-btn')?.addEventListener('click', () => {
        sendMessage();
    });
    
    // Enviar mensagem ao pressionar Enter
    document.getElementById('message-input')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

        updateNotificationsButton();
        if (Notification.permission === 'granted') {
            registerFcmAndSaveToken().catch(error => {
                console.error('Não foi possível restaurar o registro de notificações push:', error);
                sessionStorage.removeItem('chatFcmTokenReady');
                updateNotificationsButton();
            });
        }
});
