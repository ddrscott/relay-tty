import { forwardRef, type ButtonHTMLAttributes, type TouchEvent, type MouseEvent } from "react";

/**
 * Button that never steals focus from the terminal or triggers the virtual keyboard.
 *
 * Applies: tabIndex={-1}, onMouseDown preventDefault, onTouchEnd preventDefault.
 * Pass `onPress` for the action — it fires from both onTouchEnd and onClick (desktop).
 */
interface NoKbButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onTouchEnd" | "onMouseDown"> {
  onPress?: () => void;
}

export const NoKbButton = forwardRef<HTMLButtonElement, NoKbButtonProps>(
  function NoKbButton({ onPress, onClick, children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        tabIndex={-1}
        onMouseDown={(e: MouseEvent<HTMLButtonElement>) => e.preventDefault()}
        onTouchEnd={(e: TouchEvent<HTMLButtonElement>) => {
          e.preventDefault();
          onPress?.();
        }}
        onClick={(e) => {
          onPress?.();
          onClick?.(e);
        }}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
