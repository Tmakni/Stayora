import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, getToken, setSession, clearSession, getStoredEmail } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
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
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    }
    hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await api.auth.login(email, password);
    setSession(data.token, data.user?.email);
    setUser(data.user);
    return data;
  }, []);

  const register = useCallback(async (email, password) => {
    const data = await api.auth.register(email, password);
    setSession(data.token, data.user?.email);
    setUser(data.user);
    return data;
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setUser(null);
  }, []);

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
