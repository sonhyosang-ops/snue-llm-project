// Next.js 16 refers to the URLPatternInput alias that Node exposes at runtime.
// Node's current type package declares the constituent types but not this alias.
type URLPatternInput = string | URLPatternInit;

interface URLPatternOptions {
  ignoreCase?: boolean;
}
