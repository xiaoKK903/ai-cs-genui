/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 演示项目：不收集构建遥测
  experimental: {
    typedRoutes: false,
  },
};

export default nextConfig;
