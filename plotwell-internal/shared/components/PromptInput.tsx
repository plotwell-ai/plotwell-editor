import { useState, type KeyboardEvent } from "react";

interface PromptInputProps {
  onSubmit: (prompt: string) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
}

export function PromptInput({
  onSubmit,
  placeholder = "Describe what you want to generate...",
  disabled = false,
  rows = 3,
}: PromptInputProps) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setValue("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div
      style={{
        border: `1px solid ${focused ? "var(--amber)" : "var(--border)"}`,
        borderRadius: "var(--radius-lg)",
        background: "var(--surface)",
        transition: "border-color 0.15s ease",
        overflow: "hidden",
        boxShadow: focused ? "0 0 0 3px rgba(217, 119, 6, 0.08)" : "none",
      }}
    >
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        style={{
          display: "block",
          width: "100%",
          padding: "14px 16px 10px",
          fontSize: 13.5,
          lineHeight: 1.6,
          color: "var(--text-primary)",
          background: "transparent",
          border: "none",
          outline: "none",
          resize: "none",
          fontFamily: "'DM Sans', system-ui, sans-serif",
          opacity: disabled ? 0.5 : 1,
        }}
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px 10px",
          borderTop: "1px solid var(--border-subtle)",
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--text-tertiary)",
            letterSpacing: "0.02em",
          }}
        >
          ⌘ Enter to generate
        </span>
        <button
          onClick={handleSubmit}
          disabled={disabled || !value.trim()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 16px",
            borderRadius: 6,
            fontSize: 12.5,
            fontWeight: 500,
            background: disabled || !value.trim() ? "var(--surface-2)" : "var(--amber)",
            color: disabled || !value.trim() ? "var(--text-tertiary)" : "#fff",
            border: "none",
            cursor: disabled || !value.trim() ? "not-allowed" : "pointer",
            transition: "all 0.15s ease",
            letterSpacing: "0.01em",
          }}
        >
          {disabled ? (
            <>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  border: "1.5px solid var(--text-tertiary)",
                  borderTopColor: "transparent",
                  animation: "spin 0.6s linear infinite",
                  display: "inline-block",
                }}
              />
              Generating
            </>
          ) : (
            "Generate"
          )}
        </button>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
