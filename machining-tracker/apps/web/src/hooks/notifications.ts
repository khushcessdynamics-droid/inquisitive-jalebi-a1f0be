import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { useRealtimeInvalidate } from "./data";

/** Unread notifications of the signed-in user (live: new reminders arrive through Realtime). */
export function useUnreadCount(): number {
  const { access } = useAuth();
  const enabled = access?.status === "ok";
  useRealtimeInvalidate(["notifications"], ["unread-count"]);
  const q = useQuery({
    queryKey: ["unread-count"],
    enabled,
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const { count, error } = await supabase.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null);
      if (error) throw error;
      return count ?? 0;
    },
  });
  return q.data ?? 0;
}
