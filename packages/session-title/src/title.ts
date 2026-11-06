import { compile, str } from "@earendil-works/pi-schema";

export const Title = str({
  minLength: 1,
  maxLength: 80,
  pattern: "\\S",
});

const isTitle = compile(Title).check;

export function parseTitle(value: string): string {
  const title = value.trim();
  if (!isTitle(title)) {
    throw new TypeError(
      "A session title must contain non-whitespace text and be at most 80 characters",
    );
  }
  return title;
}
