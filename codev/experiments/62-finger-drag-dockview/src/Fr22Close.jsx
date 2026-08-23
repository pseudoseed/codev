export function Fr22Close({ activePanel }) {
  return (
    <button
      type="button"
      className="fr22-close"
      aria-label="Close active panel"
      disabled={!activePanel}
      onClick={() => activePanel?.api.close()}
    >
      Close
    </button>
  );
}
