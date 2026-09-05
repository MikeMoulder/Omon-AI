import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * /.well-known/x402 is where an agent looks first when all it has is a domain.
   * The handler lives at /api/manifest and is aliased here rather than placed in
   * an `app/.well-known/` directory, because a leading dot in a route segment is
   * not a convention worth betting the discovery path on.
   */
  async rewrites() {
    return [{ source: "/.well-known/x402", destination: "/api/manifest" }];
  },
};

export default nextConfig;
