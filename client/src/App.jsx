import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from './components/ui/toaster';
import { AppShell } from './components/layout/AppShell';
import { MichelMark } from './components/shared/MichelMark';
import { useAuth } from './lib/auth.jsx';

import { LoginPage } from './features/auth/LoginPage';
import { ForgotPasswordPage } from './features/auth/ForgotPasswordPage';
import { ResetPasswordPage } from './features/auth/ResetPasswordPage';

const DashboardPage = lazy(() => import('./features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const ConversationsPage = lazy(() => import('./features/conversations/ConversationsPage').then((m) => ({ default: m.ConversationsPage })));
const PropertiesPage = lazy(() => import('./features/properties/PropertiesPage').then((m) => ({ default: m.PropertiesPage })));
const CalendarPage = lazy(() => import('./features/calendar/CalendarPage').then((m) => ({ default: m.CalendarPage })));
const AutomationsPage = lazy(() => import('./features/automations/AutomationsPage').then((m) => ({ default: m.AutomationsPage })));
const IntegrationsPage = lazy(() => import('./features/integrations/IntegrationsPage').then((m) => ({ default: m.IntegrationsPage })));
const SettingsPage = lazy(() => import('./features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })));

function SplashScreen() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background">
      <MichelMark className="size-10 animate-pulse-dot" />
      <p className="text-sm text-muted-foreground">Chargement de Michel…</p>
    </div>
  );
}

function ProtectedRoute({ children }) {
  const { isAuthenticated, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <SplashScreen />;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location }} />;
  return children;
}

function PublicOnlyRoute({ children }) {
  const { isAuthenticated, ready } = useAuth();
  if (!ready) return <SplashScreen />;
  if (isAuthenticated) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <>
      <Suspense fallback={<SplashScreen />}>
        <Routes>
          <Route
            path="/login"
            element={
              <PublicOnlyRoute>
                <LoginPage />
              </PublicOnlyRoute>
            }
          />

          <Route
            path="/forgot-password"
            element={
              <PublicOnlyRoute>
                <ForgotPasswordPage />
              </PublicOnlyRoute>
            }
          />

          <Route
            path="/reset-password"
            element={
              <PublicOnlyRoute>
                <ResetPasswordPage />
              </PublicOnlyRoute>
            }
          />

          <Route
            element={
              <ProtectedRoute>
                <AppShell />
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<DashboardPage />} />
            <Route path="/conversations" element={<ConversationsPage />} />
            <Route path="/conversations/:id" element={<ConversationsPage />} />
            <Route path="/properties" element={<PropertiesPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/automations" element={<AutomationsPage />} />
            <Route path="/integrations" element={<IntegrationsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <Toaster />
    </>
  );
}
