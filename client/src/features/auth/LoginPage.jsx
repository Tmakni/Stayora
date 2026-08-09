import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Eye, EyeOff, Loader2, AlertCircle } from 'lucide-react';
import { AuthHero } from './AuthHero';
import { MichelMark } from '../../components/shared/MichelMark';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Checkbox } from '../../components/ui/checkbox';
import { AirbnbLinkField } from '../../components/shared/AirbnbLinkField';
import { useAuth } from '../../lib/auth.jsx';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function validatePassword(pw) {
  return pw.length >= 8 && pw.length <= 128 && /[A-Z]/.test(pw) && /[0-9]/.test(pw);
}

export function LoginPage() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [isRegister, setIsRegister] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [linkAirbnb, setLinkAirbnb] = useState(false);
  const [airbnbUrl, setAirbnbUrl] = useState('');

  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(null); // { text, detail } while auto-importing

  function resetErrors() {
    setFieldErrors({});
    setFormError('');
  }

  function validate() {
    const errs = {};
    if (!validateEmail(email)) errs.email = 'Adresse email invalide.';
    if (isRegister) {
      if (!validatePassword(password)) errs.password = 'Min. 8 caractères, 1 majuscule et 1 chiffre.';
      if (confirmPassword !== password) errs.confirmPassword = 'Les mots de passe ne correspondent pas.';
    } else if (!password) {
      errs.password = 'Mot de passe requis.';
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    resetErrors();
    if (!validate()) return;

    setSubmitting(true);
    try {
      if (isRegister) {
        await register(email, password);
        if (linkAirbnb && airbnbUrl.trim()) {
          await autoImportAirbnbListings(airbnbUrl.trim());
        }
      } else {
        await login(email, password);
      }
      navigate(location.state?.from?.pathname || '/', { replace: true });
    } catch (err) {
      setFormError(err.message || 'Une erreur est survenue.');
    } finally {
      setSubmitting(false);
      setProgress(null);
    }
  }

  async function autoImportAirbnbListings(profileUrl) {
    setProgress({ text: 'Recherche de vos logements Airbnb…', detail: '' });
    try {
      const scan = await api.properties.scanAirbnbProfile(profileUrl);
      const listings = scan.listings || [];
      if (listings.length === 0) {
        setProgress(null);
        return;
      }
      for (let i = 0; i < listings.length; i++) {
        const listing = listings[i];
        setProgress({ text: 'Importation de vos logements…', detail: `Logement ${i + 1}/${listings.length}` });
        try {
          const imported = await api.properties.importAirbnb(listing.id);
          const data = imported.data || {};
          await api.properties.create({ ...data, source: 'airbnb', photos: imported.photos || [] });
        } catch (_err) {
          // Best-effort — continue importing remaining listings even if one fails.
        }
      }
    } catch (_err) {
      // Import is a bonus step during registration — never block account creation on it.
    } finally {
      setProgress(null);
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

          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            {isRegister ? 'Créer un compte' : 'Bon retour'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {isRegister ? 'Commencez gratuitement en quelques secondes.' : 'Connectez-vous pour accéder à votre espace.'}
          </p>

          {formError && (
            <div className="mt-4 flex items-start gap-2 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {formError}
            </div>
          )}

          <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="vous@exemple.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={!!fieldErrors.email}
              />
              {fieldErrors.email && <p className="text-xs text-danger">{fieldErrors.email}</p>}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Mot de passe</Label>
                {!isRegister && (
                  <button
                    type="button"
                    className="text-xs font-medium text-primary hover:underline"
                    onClick={() => navigate('/forgot-password')}
                  >
                    Mot de passe oublié ?
                  </button>
                )}
              </div>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={!!fieldErrors.password}
                  className="pr-9"
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
              {fieldErrors.password && <p className="text-xs text-danger">{fieldErrors.password}</p>}
            </div>

            {isRegister && (
              <div className="space-y-1.5">
                <Label htmlFor="confirm-password">Confirmer le mot de passe</Label>
                <Input
                  id="confirm-password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  aria-invalid={!!fieldErrors.confirmPassword}
                />
                {fieldErrors.confirmPassword && <p className="text-xs text-danger">{fieldErrors.confirmPassword}</p>}
              </div>
            )}

            {isRegister && (
              <div className="space-y-2 rounded-md border border-border bg-muted/60 p-3">
                <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <Checkbox checked={linkAirbnb} onCheckedChange={(v) => setLinkAirbnb(!!v)} className="mt-0.5" />
                  <span>
                    <span className="font-medium text-foreground">Importer mes logements Airbnb</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      Synchronisez automatiquement vos logements depuis votre profil hôte.
                    </span>
                  </span>
                </label>
                {linkAirbnb && (
                  <div className="pt-1">
                    <AirbnbLinkField
                      id="register-airbnb-url"
                      label="Lien de vos annonces"
                      value={airbnbUrl}
                      onChange={setAirbnbUrl}
                      disabled={submitting}
                    />
                  </div>
                )}
              </div>
            )}

            <Button type="submit" className="w-full" size="lg" disabled={submitting}>
              {submitting && <Loader2 className="animate-spin" />}
              {isRegister ? "S'inscrire" : 'Se connecter'}
            </Button>
          </form>

          <p className="mt-5 text-center text-sm text-muted-foreground">
            {isRegister ? 'Déjà un compte ?' : 'Pas encore de compte ?'}{' '}
            <button
              type="button"
              className="font-medium text-primary hover:underline"
              onClick={() => {
                setIsRegister((v) => !v);
                resetErrors();
              }}
            >
              {isRegister ? 'Se connecter' : 'Créer un compte'}
            </button>
          </p>
        </div>
      </div>

      {progress && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background/90 backdrop-blur-sm">
          <Loader2 className="size-8 animate-spin text-primary" />
          <p className={cn('text-sm font-medium text-foreground')}>{progress.text}</p>
          {progress.detail && <p className="text-xs text-muted-foreground">{progress.detail}</p>}
        </div>
      )}
    </div>
  );
}
