const screenshotNames = [
  'hero',
  'model-picker',
  'computer-panel',
  'approval-card',
  'marketplace',
  'composio-multi-account',
  'context-menu',
  'app-settings',
  'ubuntu-computer-panel',
  'docs-onboarding',
  'docs-engine-detection',
  'docs-fresh-bot',
  'docs-model-picker',
  'docs-computer-panel',
  'docs-connected-apps',
  'docs-automations',
] as const;

type ScreenshotName = (typeof screenshotNames)[number];

export function ProductScreenshot({
  name,
  alt,
  caption,
  position = 'center',
}: {
  name: ScreenshotName;
  alt: string;
  caption?: string;
  position?: 'center' | 'top';
}) {
  return (
    <figure className="omb-product-shot">
      <div className="omb-product-shot-frame">
        <img
          src={`/screenshots/${name}.png`}
          alt={alt}
          loading="lazy"
          className={position === 'top' ? 'object-top' : 'object-center'}
        />
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
