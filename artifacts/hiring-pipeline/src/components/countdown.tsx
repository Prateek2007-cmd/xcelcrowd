import { useEffect, useState } from "react";
import { formatDistanceToNow, isPast } from "date-fns";

export function Countdown({ deadline }: { deadline: string | null | undefined }) {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    if (!deadline) return;
    const interval = setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => clearInterval(interval);
  }, [deadline]);

  if (!deadline) return null;

  const date = new Date(deadline);
  if (isPast(date)) {
    return <span className="text-red-500 font-mono text-xs">EXPIRED</span>;
  }

  return (
    <span className="text-orange-400 font-mono text-xs font-bold">
      {formatDistanceToNow(date)} left
    </span>
  );
}
