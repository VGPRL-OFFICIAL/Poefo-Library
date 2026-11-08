window.POEFO_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDa373d5z6_VXUKPLTvXy5rYm7tNy0aSS0",
  authDomain: "captu-libraly.firebaseapp.com",
  databaseURL: "https://captu-libraly-default-rtdb.firebaseio.com",
  projectId: "captu-libraly",
  storageBucket: "captu-libraly.firebasestorage.app",
  messagingSenderId: "341104400887",
  appId: "1:341104400887:web:8304c9aa2855dd945236f2",
  measurementId: "G-7NM9CC35CX"
};

window.POEFO_FIREBASE_URLS = {
  allBooksDataUrl: 'https://firebasestorage.googleapis.com/v0/b/captu-libraly.firebasestorage.app/o/livros_json%2Flivros.json?alt=media&token=3eaf739c-b9fc-45b7-ab15-800d9058655a',
  allPostsDataUrl: 'https://firebasestorage.googleapis.com/v0/b/captu-libraly.firebasestorage.app/o/livros_json%2Fposts.json?alt=media&token=e7b7b6fb-275a-45e3-9482-7830189c671f',
  defaultProfilePic: 'https://firebasestorage.googleapis.com/v0/b/captu-libraly.appspot.com/o/default_profile.png?alt=media',
  storageBaseUrl: 'https://firebasestorage.googleapis.com/v0/b/captu-libraly.firebasestorage.app/o/'
};

window.POEFO_FCM_VAPID_KEY = 'COLOQUE_SUA_PUBLIC_VAPID_KEY_AQUI';

(() => {
  let messagingSdkPromise;

  function loadMessagingSdk() {
    if (typeof firebase.messaging === 'function') return Promise.resolve();
    if (messagingSdkPromise) return messagingSdkPromise;

    messagingSdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Não foi possível carregar o Firebase Messaging.'));
      document.head.appendChild(script);
    });
    return messagingSdkPromise;
  }

  async function registerForegroundChatNotifications() {
    if (window.location.pathname === '/chat'
      || window.location.pathname.endsWith('/html/chat.html')
      || !('Notification' in window)
      || Notification.permission !== 'granted'
      || !('serviceWorker' in navigator)) return;

    const profileId = sessionStorage.getItem('currentUserId')
      || localStorage.getItem('currentUserId');
    if (!profileId) return;

    if (!firebase.apps.length) firebase.initializeApp(window.POEFO_FIREBASE_CONFIG);
    await loadMessagingSdk();

    const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    await navigator.serviceWorker.ready;
    const messaging = firebase.messaging();
    if (typeof messaging.useServiceWorker === 'function') {
      messaging.useServiceWorker(registration);
    }

    messaging.onMessage(payload => {
      if (document.visibilityState !== 'visible') return;

      const data = payload.data || {};
      const notification = payload.notification || {};
      if (!data.convId || data.senderId === profileId) return;
      const isMuted = localStorage.getItem(`chatSilentMode:${profileId}`) === 'true';

      registration.showNotification(
        data.title || notification.title || 'Nova mensagem',
        {
          body: data.body || notification.body || '',
          icon: data.icon || notification.icon || '/images/ic_chat.png',
          tag: `chat-${data.convId}`,
          renotify: false,
          silent: isMuted,
          data: { convId: data.convId }
        }
      ).catch(error => {
        console.error('Não foi possível mostrar a notificação do chat:', error);
      });
    });
  }

  window.addEventListener('load', () => {
    registerForegroundChatNotifications().catch(error => {
      console.error('Não foi possível ativar notificações fora da página do chat:', error);
    });
  }, { once: true });
})();
