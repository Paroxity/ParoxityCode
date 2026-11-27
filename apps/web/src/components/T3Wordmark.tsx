import type { SVGProps } from "react";

// Fork: release builds set this to the fork's product name; it is "" in upstream-named builds.
// See scripts/lib/product-name.ts.
const FORK_PRODUCT_NAME = import.meta.env.VITE_FORK_PRODUCT_NAME ?? "";

/** The part of the fork's name before "Code", shown where upstream draws its "T3" glyph. */
const FORK_WORDMARK_LEAD = FORK_PRODUCT_NAME.replace(/\s+Code$/, "");

export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  if (FORK_PRODUCT_NAME) return <ForkMark {...props} />;
  return (
    <svg {...props} viewBox="15.5309 37 94.3941 56.96" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Fork: a black hole, its disk crossing in front of the photon ring, which breaks around it. */
function ForkMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g transform="rotate(-14 12 12)" stroke="currentColor">
        <path
          d="M6.51 13.09A5.6 5.6 0 1 1 17.49 13.09M14.69 16.91A5.6 5.6 0 0 1 9.31 16.91"
          strokeWidth="2.4"
        />
        <path d="M1.2 12A10.8 3.3 0 0 0 22.8 12" strokeWidth="1.9" strokeLinecap="round" />
      </g>
    </svg>
  );
}

/**
 * Fork: the lead of the "T3 Code" wordmark. Upstream-named builds draw the "T3" glyph with the SVG
 * props; renamed builds write the fork's lead, such as "Paroxity", styled by `textClassName`.
 */
export function BrandWordmarkLead({
  textClassName,
  ...props
}: SVGProps<SVGSVGElement> & { readonly textClassName?: string }) {
  if (!FORK_WORDMARK_LEAD) return <T3Wordmark {...props} />;
  return (
    <span className={textClassName} aria-hidden={props["aria-hidden"]}>
      {FORK_WORDMARK_LEAD}
    </span>
  );
}
