import { useState } from "react";
import { useToast } from "./Toast";

interface CopyButtonProps {
  text: string;
  className?: string;
  label?: string;
}

export function CopyButton({ text, className = "", label }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    toast(label ? `${label} copied` : "Copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 12px",
        borderRadius: 6,
        fontSize: 12,
        fontWeight: 500,
        border: copied ? "1px solid #16a34a33" : "1px solid var(--border)",
        background: copied ? "#f0fdf4" : "var(--surface)",
        color: copied ? "#16a34a" : "var(--text-secondary)",
        cursor: "pointer",
        transition: "all 0.15s ease",
        letterSpacing: "0.01em",
      }}
    >
      {copied ? (
        <>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="4.5" y="1.5" width="6" height="7.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M1.5 4.5v6a1 1 0 001 1h5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          {label ? `Copy ${label}` : "Copy"}
        </>
      )}
    </button>
  );
}
