import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { AuthHero } from './AuthHero';
import { MichelMark } from '../../components/shared/MichelMark';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { api } from '../../lib/api';

function validatePassword(pw) {
  return pw.length >= 8 && pw.length <= 128 && /[A-Z]/.test(pw) && /[0-9]/.test(pw);
}

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [showPassword, setShowPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  function validate() {
    const errs = {};
    if (!validatePassword(newPassword)) errs.newPassword = 'Min. 8 caractères, 1 majuscule et 1 chiffre.';
    if (confirmPassword !== newPassword) errs.confirmPassword = 'Les mots de passe ne correspondent pas.';
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError('');
    setFieldErrors({});

    if (!token) {
      setFormError('Ce lien de réinitialisation est invalide ou a expiré. Veuillez en demander un nouveau.');
      return;
    }
    if (!validate()) return;

    setSubmitting(true);
    try {
      await api.auth.resetPassword({ token, newPassword, confirmPassword });
      setSuccess(true);
    } catch (err) {
      setFormError(err.message || 'Une erreur est survenue.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen bg-background">
      <AuthHero />

      <div className="flex flex-1 flex-col justify-center px-6 py-10 sm:px-10 lg:px-16">
        <div className="mx-auto w-full max-w-[380px]">
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <MichelMark className="size-8" />
            <span className="text-lg font-semibold tracking-tight">Michel</span>
          </div>

          {success ? (
            <>
              <div className="flex size-10 items-center justify-center rounded-full bg-success/10 text-success">
                <CheckCircle2 className="size-5" />
              </div>
              <h2 className="mt-4 text-xl font-semibold tracking-tight text-foreground">Mot de passe réinitialisé</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Votre mot de passe a été mis à jour avec succès. Vous pouvez maintenant vous connecter.
              </p>

              <Button type="button" className="mt-6 w-full" size="lg" onClick={() => navigate('/login')}>
                Se connecter
              </Button>
            </>
          ) : !token ? (
            <>
              <div className="flex size-10 items-center justify-center rounded-full bg-danger/10 text-danger">
                <AlertCircle className="size-5" />
              </div>
              <h2 className="mt-4 text-xl font-semibold tracking-tight text-foreground">Lien invalide</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Ce lien de réinitialisation est invalide ou a expiré. Veuillez en demander un nouveau.
              </p>

              <Button type="button" className="mt-6 w-full" size="lg" onClick={() => navigate('/forgot-password')}>
                Demander un nouveau lien
              </Button>
            </>
          ) : (
            <>
              <h2 className="text-xl font-semibold tracking-tight text-foreground">Nouveau mot de passe</h2>
              <p className="mt-1 text-sm text-muted-foreground">Choisissez un nouveau mot de passe pour votre compte.</p>

              {formError && (
                <div className="mt-4 flex items-start gap-2 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>
                    {formError}{' '}
                    <button
                      type="button"
                      className="font-medium underline"
                      onClick={() => navigate('/forgot-password')}
                    >
                      Demander un nouveau lien
                    </button>
                  </span>
                </div>
              )}

              <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="new-password">Nouveau mot de passe</Label>
                  <div className="relative">
                    <Input
                      id="new-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      placeholder="••••••••"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      aria-invalid={!!fieldErrors.newPassword}
                      className="pr-9"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                  {fieldErrors.newPassword && <p className="text-xs text-danger">{fieldErrors.newPassword}</p>}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="confirm-password">Confirmer le mot de passe</Label>
                  <Input
                    id="confirm-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    aria-invalid={!!fieldErrors.confirmPassword}
                  />
                  {fieldErrors.confirmPassword && <p className="text-xs text-danger">{fieldErrors.confirmPassword}</p>}
                </div>

                <Button type="submit" className="w-full" size="lg" disabled={submitting}>
                  {submitting && <Loader2 className="animate-spin" />}
                  Réinitialiser le mot de passe
                </Button>
              </form>

              <p className="mt-5 text-center text-sm text-muted-foreground">
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  onClick={() => navigate('/login')}
                >
                  Retour à la connexion
                </button>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
