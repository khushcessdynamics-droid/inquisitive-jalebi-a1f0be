import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { unwrap } from "../lib/errors";
import type { CancelReasonRow, MasterRow, VendorRow } from "../lib/types";
import { useRealtimeInvalidate } from "./data";

export function useCategories() {
  useRealtimeInvalidate(["work_categories"], ["work_categories"]);
  return useQuery({
    queryKey: ["work_categories"],
    queryFn: async () => unwrap(await supabase.from("work_categories").select("id,name,is_active,sort_order,version").order("sort_order").order("name")) as MasterRow[],
    staleTime: 60_000,
  });
}

export function useGivenBy() {
  useRealtimeInvalidate(["given_by_names"], ["given_by_names"]);
  return useQuery({
    queryKey: ["given_by_names"],
    queryFn: async () => unwrap(await supabase.from("given_by_names").select("id,name,is_active,sort_order,version").order("sort_order").order("name")) as MasterRow[],
    staleTime: 60_000,
  });
}

export function useVendors() {
  useRealtimeInvalidate(["vendors", "vendor_categories"], ["vendors"]);
  return useQuery({
    queryKey: ["vendors"],
    queryFn: async () => unwrap(await supabase.from("vendors").select("*, vendor_categories(work_category_id)").order("name")) as VendorRow[],
    staleTime: 30_000,
  });
}

export function useCancelReasons() {
  return useQuery({
    queryKey: ["cancel_reason_codes"],
    queryFn: async () => unwrap(await supabase.from("cancel_reason_codes").select("*").order("sort_order")) as CancelReasonRow[],
    staleTime: 60_000,
  });
}

export function useAssignableUsers(enabled = true) {
  return useQuery({
    queryKey: ["assignable-users"],
    enabled,
    queryFn: async () => unwrap(await supabase.rpc("list_assignable_users")) as Array<{ id: string; full_name: string; role_label: string }>,
    staleTime: 60_000,
  });
}
