import { CheckCircle2, MessageCircleHeart, CalendarCheck2, Mail, Building2 } from 'lucide-react';
import { MichelMark } from '../../components/shared/MichelMark';

const FEATURES = [
  { icon: MessageCircleHeart, text: 'Réponses IA suggérées en un clic, dans votre ton' },
  { icon: CalendarCheck2, text: 'Calendrier et disponibilités toujours à jour' },
  { icon: Mail, text: 'Gmail, Airbnb, Booking et Vrbo centralisés' },
  { icon: Building2, text: 'Multi-logements, une seule boîte de réception' },
];

export function AuthHero() {
  return (
    <div className="relative hidden overflow-hidden bg-[#0D0E18] p-10 text-white lg:flex lg:w-[46%] lg:flex-col lg:justify-between xl:w-1/2">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-24 -top-24 size-[420px] rounded-full bg-[#635BFF]/25 blur-[110px]" />
        <div className="absolute -right-16 top-1/3 size-[360px] rounded-full bg-[#2563EB]/20 blur-[110px]" />
        <div className="absolute bottom-[-140px] left-1/4 size-[380px] rounded-full bg-[#635BFF]/15 blur-[120px]" />
      </div>

      <div className="relative z-10 flex items-center gap-2.5">
        <MichelMark className="size-8" />
        <span className="text-lg font-semibold tracking-tight">Michel</span>
      </div>

      <div className="relative z-10 max-w-md">
        <h1 className="text-[2.1rem] font-semibold leading-[1.15] tracking-tight">
          Gérez vos messages voyageurs, plus vite.
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-white/60">
          Centralisez Airbnb, Booking.com, Vrbo et Gmail dans une seule boîte de réception,
          et laissez Michel préparer des réponses fiables pendant que vous gardez le contrôle.
        </p>

        <div className="mt-8 flex gap-6">
          <Stat value="3×" label="Plus rapide" />
          <Stat value="100%" label="Automatisable" />
          <Stat value="24/7" label="Disponible" />
        </div>

        <ul className="mt-8 space-y-3">
          {FEATURES.map((f) => (
            <li key={f.text} className="flex items-start gap-2.5 text-sm text-white/75">
              <f.icon className="mt-0.5 size-4 shrink-0 text-[#8F89FF]" />
              {f.text}
            </li>
          ))}
        </ul>
      </div>

      <div className="relative z-10 max-w-md rounded-lg border border-white/10 bg-white/[0.04] p-4 backdrop-blur-sm">
        <div className="flex items-start gap-1.5 text-[13px] leading-relaxed text-white/70">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
          « J&apos;ai réduit de moitié le temps passé à répondre à mes voyageurs, sans perdre le contact humain. »
        </div>
        <div className="mt-3 flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-full bg-[#635BFF]/30 text-xs font-semibold">
            C
          </div>
          <div className="text-xs">
            <div className="font-medium">Camille R.</div>
            <div className="text-white/50">Hôte de 4 logements</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label }) {
  return (
    <div>
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs text-white/50">{label}</div>
    </div>
  );
}
