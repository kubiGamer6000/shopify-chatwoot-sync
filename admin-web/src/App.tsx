import { Navigate, Route, Routes } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { LoginScreen, PendingScreen } from './components/AuthScreens';
import { SettingsPage } from './pages/SettingsPage';
import { PromptTesterPage } from './pages/PromptTesterPage';
import { UsersPage } from './pages/UsersPage';

function FullScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">{children}</div>
  );
}

export function App() {
  const { user, role, loading } = useAuth();

  if (loading) {
    return (
      <FullScreen>
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </FullScreen>
    );
  }

  if (!user) {
    return (
      <FullScreen>
        <LoginScreen />
      </FullScreen>
    );
  }

  if (role !== 'admin') {
    return (
      <FullScreen>
        <PendingScreen />
      </FullScreen>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/settings" replace />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/tester" element={<PromptTesterPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="*" element={<Navigate to="/settings" replace />} />
      </Routes>
    </Layout>
  );
}
