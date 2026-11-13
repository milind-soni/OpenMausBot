import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export interface HeaderCollapseResult {
  step: number; // 0: wide, 1: compact, 2: moreMenu, 3: iconOnly
  isSpacious: boolean;
  isCompact: boolean;
  isTight: boolean;
  isVeryTight: boolean;
  modelMode: "full" | "compact" | "iconOnly";
  showButtonsText: boolean;
  collapseSecondaryToMenu: boolean;
}

interface UseHeaderCollapseOptions {
  headerRef: RefObject<HTMLElement | null>;
  nameRef: RefObject<HTMLElement | null>;
  actionsRef: RefObject<HTMLElement | null>;
  estimatedInitialWidth?: number;
}

export function useHeaderCollapse({
  headerRef,
  nameRef,
  actionsRef,
  estimatedInitialWidth,
}: UseHeaderCollapseOptions): HeaderCollapseResult {
  // Compute initial step based on estimated container width to prevent first-frame wide flash
  const initialStep = (() => {
    const width = estimatedInitialWidth ?? (typeof window !== "undefined" ? window.innerWidth : 1024);
    if (width < 460) return 3; // iconOnly model + More menu
    if (width < 680) return 1; // compact model + icon-only buttons
    return 0; // wide
  })();

  const [step, setStep] = useState<number>(initialStep);
  const stepRef = useRef(step);
  stepRef.current = step;

  useLayoutEffect(() => {
    const header = headerRef.current;
    const nameEl = nameRef.current;
    const actionsEl = actionsRef.current;
    if (!header || !nameEl || !actionsEl) return;

    const measureAndReflow = () => {
      const headerWidth = header.clientWidth;
      if (headerWidth <= 0) return;

      const headerStyle = window.getComputedStyle(header);
      const padLeft = parseFloat(headerStyle.paddingLeft) || 14;
      const padRight = parseFloat(headerStyle.paddingRight) || 14;
      const availableWidth = headerWidth - padLeft - padRight;
      const headerGap = 8;

      const namePreferredWidth = nameEl.scrollWidth;
      const actionsWidth = actionsEl.scrollWidth;
      const totalNeeded = namePreferredWidth + headerGap + actionsWidth;
      const currentStep = stepRef.current;

      if (totalNeeded > availableWidth) {
        if (currentStep < 3) {
          setStep((s) => Math.min(3, s + 1));
        }
      } else {
        const spare = availableWidth - totalNeeded;
        // Step up with hysteresis to prevent oscillation
        if (currentStep === 3 && spare >= 50) {
          setStep(2);
        } else if (currentStep === 2 && spare >= 55) {
          setStep(1);
        } else if (currentStep === 1 && spare >= 140) {
          setStep(0);
        }
      }
    };

    measureAndReflow();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        measureAndReflow();
      });
      observer.observe(header);
      observer.observe(nameEl);
      observer.observe(actionsEl);
      return () => observer.disconnect();
    } else {
      window.addEventListener("resize", measureAndReflow);
      return () => window.removeEventListener("resize", measureAndReflow);
    }
  }, [headerRef, nameRef, actionsRef, step]);

  const isSpacious = step === 0;
  const isCompact = step === 1;
  const isTight = step >= 2;
  const isVeryTight = step === 3;

  return {
    step,
    isSpacious,
    isCompact,
    isTight,
    isVeryTight,
    modelMode: isVeryTight ? "iconOnly" : isTight || isCompact ? "compact" : "full",
    showButtonsText: isSpacious,
    collapseSecondaryToMenu: isTight,
  };
}
