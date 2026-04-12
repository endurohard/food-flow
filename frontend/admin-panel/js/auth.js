/**
 * FoodFlow Auth Module
 * Include this script on every admin-panel page to handle:
 * - Auto-redirect to login if not authenticated
 * - Automatic token refresh
 * - Authenticated fetch wrapper
 */

const AUTH_API_BASE_URL = window.location.hostname === 'localhost'
    ? 'http://localhost:8000'
    : '';

// Check authentication on page load
(function checkAuth() {
    const token = localStorage.getItem('accessToken');
    if (!token) {
        redirectToLogin();
        return;
    }
})();

function redirectToLogin() {
    const currentPath = window.location.pathname;
    if (!currentPath.includes('login.html')) {
        window.location.href = '/admin-panel/login.html';
    }
}

function getAccessToken() {
    return localStorage.getItem('accessToken');
}

function getUser() {
    try {
        return JSON.parse(localStorage.getItem('user') || 'null');
    } catch {
        return null;
    }
}

async function refreshAccessToken() {
    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) {
        throw new Error('No refresh token');
    }

    const res = await fetch(`${AUTH_API_BASE_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
    });

    if (!res.ok) {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('user');
        throw new Error('Refresh failed');
    }

    const data = await res.json();
    localStorage.setItem('accessToken', data.accessToken);
    localStorage.setItem('refreshToken', data.refreshToken);
    return data.accessToken;
}

/**
 * Authenticated fetch wrapper.
 * Automatically adds Authorization header and handles token refresh on 401.
 */
async function authFetch(url, options = {}) {
    const fullUrl = url.startsWith('http') ? url : `${AUTH_API_BASE_URL}${url}`;

    const headers = {
        'Content-Type': 'application/json',
        ...options.headers,
        'Authorization': `Bearer ${getAccessToken()}`
    };

    let res = await fetch(fullUrl, { ...options, headers });

    // If 401, try to refresh token and retry once
    if (res.status === 401) {
        try {
            const newToken = await refreshAccessToken();
            headers['Authorization'] = `Bearer ${newToken}`;
            res = await fetch(fullUrl, { ...options, headers });
        } catch {
            redirectToLogin();
            throw new Error('Session expired');
        }
    }

    return res;
}

async function logout() {
    const refreshToken = localStorage.getItem('refreshToken');

    try {
        await fetch(`${AUTH_API_BASE_URL}/api/auth/logout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken })
        });
    } catch {
        // Ignore errors on logout
    }

    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    redirectToLogin();
}
