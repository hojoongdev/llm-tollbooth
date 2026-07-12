/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server bundle so the Docker runtime stage stays small.
  output: "standalone",
};

export default nextConfig;
