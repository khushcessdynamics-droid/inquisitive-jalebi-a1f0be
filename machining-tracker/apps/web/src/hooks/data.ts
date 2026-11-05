import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { DateFormat } from "@cess/shared";
import { supabase } from "../lib/supabase";
import { unwrap } from "../lib/errors";
import type { SettingRow } from "../lib/types";

/** Re-fetch a query whenever one of the given tables changes (Supabase Realtime, RLS-filtered). */
export function useRealtimeInvalidate(tables: string[], queryKey: QueryKey) {
  const queryClient = useQueryClient();
  const keyString = JSON.stringify(queryKey);
  const tableString = tables.join(",");
  useEffect(() => {
    const channel = supabase.channel(`rt-${tableString}-${Math.random().toString(36).slice(2)}`);
    for (const table of tableString.split(",")) {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, () => {
        void queryClient.invalidateQueries({ queryKey: JSON.parse(keyString) as QueryKey });
      });
    }
    channel.subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [tableString, keyString, queryClient]);
}

export function useSettings() {
  useRealtimeInvalidate(["app_settings"], ["settings"]);
  return useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const rows = unwrap(await supabase.from("app_settings").select("*").order("key")) as SettingRow[];
      return Object.fromEntries(rows.map((r) => [r.key, r])) as Record<string, SettingRow>;
    },
  });
}

export function useDateFormat(): DateFormat {
  const { data } = useSettings();
  return ((data?.localization?.value as { date_format?: DateFormat } | undefined)?.date_format ?? "dd-MMM-yyyy") as DateFormat;
}
