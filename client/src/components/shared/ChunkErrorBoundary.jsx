import { Component } from 'react';

/**
 * Rattrape l'échec de chargement d'un morceau de code, et recharge une fois.
 *
 * POURQUOI
 * --------
 * Les pages sont chargées à la demande, sous des noms de fichiers hachés qui
 * changent à chaque build. Un onglet resté ouvert pendant un déploiement garde
 * donc en mémoire les noms de l'ANCIEN build. Au clic suivant sur une page pas
 * encore visitée, le fichier demandé n'existe plus : l'import échoue, l'erreur
 * traverse Suspense, React démonte l'arbre, et l'écran devient blanc.
 *
 * C'est exactement le symptôme « je clique sur Paramètres et j'ai une page
 * blanche » : une seule page touchée, celle dont le morceau manque, les autres
 * déjà chargées continuant de fonctionner.
 *
 * La cause principale était un en-tête de cache trop large sur index.html, et
 * elle est corrigée côté serveur. Ce garde-fou traite ce que l'en-tête ne peut
 * pas traiter : l'onglet déjà ouvert au moment du déploiement.
 *
 * UN SEUL RECHARGEMENT
 * --------------------
 * Le garde contre la boucle est essentiel. Sans lui, une panne qui n'a rien à
 * voir avec un déploiement — un fichier réellement absent, un réseau coupé —
 * ferait recharger la page sans fin, ce qui est pire qu'un écran blanc :
 * l'utilisateur ne peut même plus lire le message.
 *
 * Le garde retient l'INSTANT du dernier rechargement, et non un simple drapeau.
 * Un drapeau devait être effacé quelque part, et l'effacer au montage ne
 * marchait pas : ce composant se monte dès que Suspense affiche son écran
 * d'attente, donc AVANT que le morceau de code ait abouti. Le drapeau était
 * remis à zéro juste avant l'échec suivant, et la page rechargeait en boucle —
 * constaté en simulant un déploiement, la navigation n'aboutissait jamais.
 *
 * Un horodatage n'a pas besoin d'être effacé : au-delà du délai de garde, un
 * futur déploiement bénéficie de nouveau de la reprise automatique.
 */

const RELOAD_AT = 'michel:chunk-reload-at';

// En deçà, un second échec est forcément la même panne : on cesse de recharger
// et on parle à l'utilisateur. Au-delà, c'est une nouvelle visite, donc un
// nouveau déploiement mérite sa reprise silencieuse.
const RELOAD_GUARD_MS = 30000;

/** Un import dynamique qui échoue, par opposition à une vraie erreur de rendu. */
function isChunkLoadError(error) {
  const message = String((error && error.message) || '');
  const name = String((error && error.name) || '');
  return (
    name === 'ChunkLoadError' ||
    /Loading chunk \d+ failed/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message)
  );
}

export class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(error) {
    if (!isChunkLoadError(error)) {
      // Ce n'est pas un problème de version : laisser remonter plutôt que de
      // masquer un vrai bug derrière un message de mise à jour.
      throw error;
    }

    let recentlyReloaded = true;
    try {
      const last = parseInt(sessionStorage.getItem(RELOAD_AT) || '0', 10);
      recentlyReloaded = Number.isFinite(last) && Date.now() - last < RELOAD_GUARD_MS;
      if (!recentlyReloaded) sessionStorage.setItem(RELOAD_AT, String(Date.now()));
    } catch (_) {
      // Navigation privée ou stockage refusé : on ne recharge pas, faute de
      // pouvoir garantir qu'on ne le fera pas en boucle.
      recentlyReloaded = true;
    }

    if (!recentlyReloaded) {
      window.location.reload();
      return { failed: false };
    }

    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm font-semibold text-foreground">Une nouvelle version est disponible</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Cette page n&apos;a pas pu être chargée parce que l&apos;application a été mise à jour
          pendant votre visite. Rechargez pour continuer.
        </p>
        <button
          type="button"
          onClick={() => {
            try {
              // Geste explicite de l'utilisateur : il reprend la main sur le
              // garde anti-boucle, qui ne protège que les reprises automatiques.
              sessionStorage.removeItem(RELOAD_AT);
            } catch (_) {
              // Rien à nettoyer.
            }
            window.location.reload();
          }}
          className="min-h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Recharger
        </button>
      </div>
    );
  }
}
