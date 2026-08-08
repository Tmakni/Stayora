import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from './components/ui/toaster';
import { AppShell } from './components/layout/AppShell';
import { MichelMark } from './components/shared/MichelMark';
import { useAuth } from './lib/auth.jsx';

import { LoginPage } from './features/auth/LoginPage';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { ConversationsPage } from './features/conversations/ConversationsPage';
import { PropertiesPage } from './features/properties/PropertiesPage';
import { CalendarPage } from './features/calendar/CalendarPage';
import { AutomationsPage } from './features/automations/AutomationsPage';
import { IntegrationsPage } from './features/integrations/IntegrationsPage';
import { SettingsPage } from './features/settings/SettingsPage';

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
      <Toaster />
    </>
  );
}
