// Discover on a phone: the same view and data as the desktop shot.
import discover from "./discover.mjs";

export default {
  ...discover,
  width: 780,
  height: 1688,
  viewport: { width: 390, height: 844 },
  scale: 2,
  mobile: true,
};
