import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, Sun, Moon, LogOut } from 'lucide-react';
import { PageContainer, PageHeader } from '../../components/shared/PageHeader';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { useAuth } from '../../lib/auth.jsx';
import { api } from '../../lib/api';
import { getTheme, applyTheme } from '../../lib/theme';
import { formatDateShort } from '../../lib/utils';

export function SettingsPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [theme, setThemeState] = useState(getTheme);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwError, setPwError] = useState('');

  const changePassword = useMutation({ mutationFn: (payload) => api.auth.changePassword(payload) });

  function selectTheme(next) {
    applyTheme(next);
    setThemeState(next);
  }

  function handleLogout() {
    logout();
    navigate('/login');
  }

  async function handlePasswordSubmit(e) {
    e.preventDefault();
    setPwError('');
    if (newPassword !== confirmPassword) {
      setPwError('Les nouveaux mots de passe ne correspondent pas.');
      return;
    }
    if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setPwError('Le mot de passe doit contenir au moins 8 caractères, 1 majuscule et 1 chiffre.');
      return;
    }
    try {
      await changePassword.mutateAsync({ currentPassword, newPassword, confirmPassword });
      toast.success('Mot de passe mis à jour');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPwError(err.message || 'Échec de la mise à jour.');
    }
  }

  return (
    <PageContainer className="max-w-3xl">
      <PageHeader title="Paramètres" description="Apparence, compte et sécurité." />

      <div className="mt-5 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Apparence</CardTitle>
            <CardDescription>Choisissez le thème de l&apos;interface.</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button variant={theme === 'light' ? 'default' : 'outline'} size="sm" onClick={() => selectTheme('light')}>
              <Sun /> Clair
            </Button>
            <Button variant={theme === 'dark' ? 'default' : 'outline'} size="sm" onClick={() => selectTheme('dark')}>
              <Moon /> Sombre
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Compte</CardTitle>
            <CardDescription>
              Connecté en tant que <span className="font-medium text-foreground">{user?.email}</span>
              {user?.created_at ? ` · membre depuis le ${formatDateShort(user.created_at)}` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" className="text-danger hover:bg-danger/10" onClick={handleLogout}>
              <LogOut /> Se déconnecter
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sécurité</CardTitle>
            <CardDescription>Modifier votre mot de passe.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="max-w-sm space-y-3" onSubmit={handlePasswordSubmit}>
              {pwError && <p className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{pwError}</p>}
              <div className="space-y-1.5">
                <Label htmlFor="current-password">Mot de passe actuel</Label>
                <Input id="current-password" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-password">Nouveau mot de passe</Label>
                <Input id="new-password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-password-confirm">Confirmer le nouveau mot de passe</Label>
                <Input id="new-password-confirm" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" />
              </div>
              <p className="text-xs text-muted-foreground">Minimum 8 caractères, au moins 1 majuscule et 1 chiffre.</p>
              <Button type="submit" size="sm" disabled={changePassword.isPending}>
                {changePassword.isPending && <Loader2 className="animate-spin" />}
                Modifier le mot de passe
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
