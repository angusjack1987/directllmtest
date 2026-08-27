import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The order store writes to .data/ at runtime; keep it out of the trace.
  outputFileTracingExcludes: { "*": [".data/**"] },
};

export default nextConfig;
