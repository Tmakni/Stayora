import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, AlertCircle, MailCheck } from 'lucide-react';
import { AuthHero } from './AuthHero';
import { MichelMark } from '../../components/shared/MichelMark';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { api } from '../../lib/api';

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function ForgotPasswordPage() {
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError('');
    setFieldError('');

    if (!validateEmail(email)) {
      setFieldError('Adresse email invalide.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.auth.requestPasswordReset(email);
      setSuccessMessage(
        res?.message || 'Si un compte existe avec cet email, vous recevrez un lien de réinitialisation.'
      );
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

          {successMessage ? (
            <>
              <div className="flex size-10 items-center justify-center rounded-full bg-success/10 text-success">
                <MailCheck className="size-5" />
              </div>
              <h2 className="mt-4 text-xl font-semibold tracking-tight text-foreground">Vérifiez votre boîte mail</h2>
              <p className="mt-1 text-sm text-muted-foreground">{successMessage}</p>

              <Button type="button" className="mt-6 w-full" size="lg" onClick={() => navigate('/login')}>
                Retour à la connexion
              </Button>
            </>
          ) : (
            <>
              <h2 className="text-xl font-semibold tracking-tight text-foreground">Mot de passe oublié</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Entrez votre email et nous vous enverrons un lien pour réinitialiser votre mot de passe.
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
                    aria-invalid={!!fieldError}
                    autoFocus
                  />
                  {fieldError && <p className="text-xs text-danger">{fieldError}</p>}
                </div>

                <Button type="submit" className="w-full" size="lg" disabled={submitting}>
                  {submitting && <Loader2 className="animate-spin" />}
                  Envoyer le lien de réinitialisation
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
