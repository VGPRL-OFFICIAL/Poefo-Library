window.PoefoAuthProfile = (() => {
    const PRIVACY_POLICY_VERSION = '1.0';

    function usersRef() {
        return firebase.database().ref('usuarios');
    }

    function hasCurrentPrivacyConsent(profile) {
        return profile?.data?.privacyConsent?.version === PRIVACY_POLICY_VERSION;
    }

    async function savePrivacyConsent(profile, source) {
        const privacyConsent = {
            version: PRIVACY_POLICY_VERSION,
            acceptedAt: firebase.database.ServerValue.TIMESTAMP,
            source
        };
        await usersRef().child(profile.id).child('privacyConsent').set(privacyConsent);
        return { ...profile, data: { ...profile.data, privacyConsent } };
    }

    function firstProfile(snapshot) {
        if (!snapshot.exists()) return null;
        const [id, data] = Object.entries(snapshot.val())[0];
        return { id, data };
    }

    async function findByEmail(email) {
        const normalizedEmail = String(email || '').trim().toLowerCase();
        if (!normalizedEmail) return null;

        const snapshot = await usersRef().orderByChild('email').equalTo(normalizedEmail).once('value');
        const exactMatch = firstProfile(snapshot);
        if (exactMatch) return exactMatch;

        const allUsers = await usersRef().once('value');
        const users = allUsers.val() || {};
        const entry = Object.entries(users).find(([, profile]) =>
            String(profile?.email || '').trim().toLowerCase() === normalizedEmail
        );
        return entry ? { id: entry[0], data: entry[1] } : null;
    }

    async function findByLogin(identifier) {
        const normalized = String(identifier || '').trim().toLowerCase();
        if (!normalized) return null;
        if (normalized.includes('@')) return findByEmail(normalized);

        const snapshot = await usersRef().orderByChild('nome_usuario').equalTo(normalized).once('value');
        const exactMatch = firstProfile(snapshot);
        if (exactMatch) return exactMatch;

        const allUsers = await usersRef().once('value');
        const users = allUsers.val() || {};
        const entry = Object.entries(users).find(([, profile]) =>
            String(profile?.nome_usuario || '').trim().toLowerCase() === normalized
        );
        return entry ? { id: entry[0], data: entry[1] } : null;
    }

    async function findByAuthUid(uid) {
        const snapshot = await usersRef().orderByChild('authUid').equalTo(uid).once('value');
        const exactMatch = firstProfile(snapshot);
        if (exactMatch) return exactMatch;

        const allUsersSnapshot = await usersRef().once('value');
        const users = allUsersSnapshot.val() || {};
        const entry = Object.entries(users).find(([, profile]) => profile?.authUid === uid);
        if (!entry) return null;
        const authUser = firebase.auth().currentUser;
        if (!authUser || authUser.uid !== uid) throw new Error('A sessão autenticada não corresponde ao perfil encontrado.');
        return attachAuthUser({ id: entry[0], data: entry[1] }, authUser);
    }

    async function attachAuthUser(profile, authUser) {
        if (profile.data.bloqueado === true) {
            throw new Error('Esta conta está bloqueada. Entre em contato com a administração.');
        }

        const updates = {
            authUid: authUser.uid,
            email: String(authUser.email || profile.data.email || '').trim().toLowerCase(),
            senha: null
        };
        await usersRef().child(profile.id).update(updates);
        return { id: profile.id, data: { ...profile.data, ...updates } };
    }

    function normalizeUsername(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9._-]/g, '')
            .slice(0, 24) || 'leitor';
    }

    async function createProfileForAuthUser(authUser) {
        if (!authUser.email) throw new Error('A conta autenticada não possui um e-mail.');

        const existing = await findByEmail(authUser.email);
        if (existing) return attachAuthUser(existing, authUser);

        const email = authUser.email.trim().toLowerCase();
        const preferredName = normalizeUsername(authUser.displayName || email.split('@')[0]);
        let username = preferredName;
        const usernameSnapshot = await usersRef().orderByChild('nome_usuario').equalTo(username).once('value');
        if (usernameSnapshot.exists()) {
            username = `${preferredName}_${authUser.uid.slice(0, 6)}`;
        }

        const profile = {
            authUid: authUser.uid,
            email,
            nome_completo: authUser.displayName || preferredName,
            nome_usuario: username,
            foto_perfil: authUser.photoURL || window.POEFO_FIREBASE_URLS?.defaultProfilePic || '../images/user_ic.png',
            criadoEm: firebase.database.ServerValue.TIMESTAMP
        };
        const profileRef = usersRef().push();
        await profileRef.set(profile);
        return attachAuthUser({ id: profileRef.key, data: profile }, authUser);
    }

    function saveSession(profile, authUser) {
        const name = profile.data.nome_usuario || profile.data.nome_completo || authUser.displayName || 'Leitor';
        const picture = profile.data.foto_perfil || authUser.photoURL || '../images/user_ic.png';
        const values = {
            currentUserId: profile.id,
            currentUserName: name,
            currentUserPic: picture,
            currentUserAvatar: picture,
            currentUserAuthUid: authUser.uid
        };

        Object.entries(values).forEach(([key, value]) => {
            sessionStorage.setItem(key, value);
            localStorage.setItem(key, value);
        });
    }

    return {
        PRIVACY_POLICY_VERSION,
        hasCurrentPrivacyConsent,
        savePrivacyConsent,
        findByEmail,
        findByLogin,
        findByAuthUid,
        attachAuthUser,
        createProfileForAuthUser,
        saveSession
    };
})();
