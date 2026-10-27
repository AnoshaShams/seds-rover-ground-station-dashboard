interface LinkDropButtonProps {
  socketOpen: boolean;
  dropActive: boolean;
  dropRemainingMs: number;
  onDrop: () => void;
}

export function LinkDropButton({ socketOpen, dropActive, dropRemainingMs, onDrop }: LinkDropButtonProps) {
  // aria-disabled instead of the disabled attribute so keyboard focus stays on
  // the button while a drop is running
  const unavailable = !socketOpen || dropActive;

  return (
    <button
      type="button"
      className={`btn-drop${dropActive ? " is-active" : ""}`}
      aria-disabled={unavailable}
      onClick={() => {
        if (!unavailable) onDrop();
      }}
      title={socketOpen ? "Ask the server to hold frames to test the link watchdog" : "Socket not open"}
    >
      {dropActive ? (
        <>
          LINK DROP ACTIVE <span className="num">{(dropRemainingMs / 1000).toFixed(1)} s</span>
        </>
      ) : (
        "SIMULATE LINK DROP"
      )}
    </button>
  );
}
