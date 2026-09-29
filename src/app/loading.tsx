import { RailSkeleton } from "../components/discover";

export default function Loading() {
  return (
    <div className="min-h-screen md:flex" aria-hidden="true">
      <aside className="hidden md:block md:w-56 md:shrink-0 md:fixed md:inset-y-0 border-r border-edge bg-panel p-4">
        <div className="skel mb-8 h-6 w-28" />
        <div className="skel mb-2 h-8 w-full" />
        <div className="skel mb-2 h-8 w-full" />
        <div className="skel h-8 w-full" />
      </aside>
      <div className="md:ml-56 min-w-0 flex-1">
        <div className="mx-auto max-w-6xl p-4 md:p-8">
          <div className="skel mb-6 h-9 w-64" />
          <div className="skel mb-4 h-9 w-full" />
          <div className="flex flex-col gap-5">
            <RailSkeleton count={6} />
            <RailSkeleton count={6} />
            <RailSkeleton count={5} />
            <RailSkeleton count={5} />
          </div>
        </div>
      </div>
    </div>
  );
}
