export default function AITrendSpotter() {
  return (
    <div className="animate-fade-in">
      <div className="page-header mb-8">
        <p className="text-2xs font-medium uppercase text-neutral-400 tracking-widest mb-2">
          AI Agent
        </p>
        <h1 className="page-title">The Trend Spotter</h1>
      </div>

      <section className="border border-neutral-200 rounded-md p-8 mb-8 max-w-3xl">
        <p className="text-base text-neutral-700 leading-relaxed">
          The Trend Spotter scans social media and cultural signals 24/7,{' '}
          <strong className="font-semibold text-neutral-900">
            triggering The Merchandiser to instantly build on-trend outfits and
            bundles
          </strong>{' '}
          to capture revenue before the hype fades.
        </p>
      </section>

      <section className="max-w-3xl">
        <h2 className="text-lg font-semibold text-neutral-900 mb-4">
          Key capabilities
        </h2>
        <ul className="space-y-3 text-sm text-neutral-700">
          <Capability
            title="24/7 social listening"
            description="Continuously monitors TikTok, Instagram, Pinterest and other cultural channels for emerging styles and themes."
          />
          <Capability
            title="Cultural signal detection"
            description="Surfaces patterns the moment they go from niche to viral — preppy scholar, soft girl, quiet luxury, you name it."
          />
          <Capability
            title="Auto-triggered outfit creation"
            description="The instant a trend lifts off, hands the brief to The Merchandiser to assemble matching outfits from your live catalog."
          />
        </ul>
      </section>

      <section className="mt-10 max-w-3xl border border-neutral-200 rounded-md p-6 bg-neutral-50">
        <h3 className="text-sm font-semibold text-neutral-900 mb-1">
          Coming soon
        </h3>
        <p className="text-sm text-neutral-600">
          Configuration and live trend feed for your store will land here. For
          now, the agent runs in the background — your AI Stylist will start
          referencing fresh trends automatically once it goes live.
        </p>
      </section>
    </div>
  );
}

function Capability({ title, description }) {
  return (
    <li className="flex gap-3">
      <span className="mt-1.5 inline-block w-1.5 h-1.5 rounded-full bg-neutral-900 flex-shrink-0" />
      <div>
        <p className="font-medium text-neutral-900">{title}</p>
        <p className="text-neutral-600">{description}</p>
      </div>
    </li>
  );
}
