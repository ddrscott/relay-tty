import { useState, useCallback, useRef } from "react";

interface CopyableIdProps {
  value: string;
  className?: string;
}

/**
 * Renders a session ID that copies to clipboard on tap/click.
 * Shows brief "Copied!" feedback inline, then reverts to the ID.
 */
export function CopyableId({ value, className = "" }: CopyableIdProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleCopy = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.stopPropagation();
      e.preventDefault();
      navigator.clipboard.writeText(value).then(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        setCopied(true);
        timerRef.current = setTimeout(() => setCopied(false), 1200);
      });
    },
    [value]
  );

  return (
    <span
      className={`cursor-pointer select-none hover:text-[#e2e8f0] active:text-[#22c55e] transition-colors ${className}`}
      onClick={handleCopy}
      onMouseDown={(e) => e.preventDefault()}
      tabIndex={-1}
      title="Click to copy session ID"
    >
      {copied ? "Copied!" : value}
    </span>
  );
}
