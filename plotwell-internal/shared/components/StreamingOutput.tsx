import { useEffect, useRef } from "react";

interface StreamingOutputProps {
  content: string;
  isStreaming: boolean;
  className?: string;
}

export function StreamingOutput({
  content,
  isStreaming,
  className = "",
}: StreamingOutputProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isStreaming && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [content, isStreaming]);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 12.5,
        lineHeight: 1.8,
        whiteSpace: "pre-wrap",
        overflowY: "auto",
        background: "#111115",
        color: "#d4d0e0",
        borderRadius: "var(--radius-lg)",
        padding: "20px 24px",
        border: "1px solid #2a2a35",
        position: "relative",
        minHeight: 120,
      }}
    >
      {content || (
        <span style={{ color: "#4a4858", fontStyle: "italic" }}>
          Output will appear here...
        </span>
      )}
      {isStreaming && (
        <span
          style={{
            display: "inline-block",
            width: 2,
            height: "1em",
            background: "var(--amber)",
            marginLeft: 2,
            verticalAlign: "text-bottom",
            animation: "cursor-blink 0.8s ease-in-out infinite",
          }}
        />
      )}
    </div>
  );
}
