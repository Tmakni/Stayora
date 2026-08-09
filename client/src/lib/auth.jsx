import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, getToken, setSession, clearSession, getStoredEmail } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState(() => {
    const email = getStoredEmail();
    return email ? { email } : null;
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      if (!getToken()) {
        setReady(true);
        return;
      }
      try {
        const data = await api.auth.me();
        if (!cancelled) setUser(data.user);
      } catch (err) {
        if (!cancelled && err.sessionExpired) {
          clearSession();
          setUser(null);
          queryClient.clear();
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    }
    hydrate();
    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  const login = useCallback(async (email, password) => {
    const data = await api.auth.login(email, password);
    // Defensive: drop any data cached under a previous session before adopting
    // the new one (covers session-expiry/refresh paths that clear the token
    // outside this component and can't reach the query cache themselves).
    queryClient.clear();
    setSession(data.token, data.user?.email);
    setUser(data.user);
    return data;
  }, [queryClient]);

  const register = useCallback(async (email, password) => {
    const data = await api.auth.register(email, password);
    queryClient.clear();
    setSession(data.token, data.user?.email);
    setUser(data.user);
    return data;
  }, [queryClient]);

  const logout = useCallback(() => {
    clearSession();
    setUser(null);
    // Wipe every cached server response (properties, conversations, sync/gmail
    // accounts, etc). Without this, React Query's in-memory cache survives the
    // logout — if a different user logs in on the same tab right after, they
    // would briefly render the previous user's cached data (e.g. their
    // properties list) until the first refetch completes. This was the root
    // cause of data appearing to "leak" across accounts on a shared browser.
    queryClient.clear();
  }, [queryClient]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!getToken(),
        ready,
        login,
        register,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
