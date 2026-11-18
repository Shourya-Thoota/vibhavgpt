import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn's standard class-name helper: clsx for conditions, tailwind-merge so
// a later utility wins over an earlier one that sets the same property.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
