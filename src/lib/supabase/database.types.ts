export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      areas: {
        Row: {
          id: string
          name: string
        }
        Insert: {
          id?: string
          name: string
        }
        Update: {
          id?: string
          name?: string
        }
        Relationships: []
      }
      listings: {
        Row: {
          cost_to_perform: string | null
          created_at: string
          description: string | null
          host: string | null
          id: string
          one_off_date: string | null
          sign_up_method: string | null
          start_time: string
          status: Database["public"]["Enums"]["listing_status"]
          ticket_price: string | null
          ticket_url: string | null
          title: string
          type: Database["public"]["Enums"]["listing_type"]
          venue_id: string
        }
        Insert: {
          cost_to_perform?: string | null
          created_at?: string
          description?: string | null
          host?: string | null
          id?: string
          one_off_date?: string | null
          sign_up_method?: string | null
          start_time: string
          status?: Database["public"]["Enums"]["listing_status"]
          ticket_price?: string | null
          ticket_url?: string | null
          title: string
          type: Database["public"]["Enums"]["listing_type"]
          venue_id: string
        }
        Update: {
          cost_to_perform?: string | null
          created_at?: string
          description?: string | null
          host?: string | null
          id?: string
          one_off_date?: string | null
          sign_up_method?: string | null
          start_time?: string
          status?: Database["public"]["Enums"]["listing_status"]
          ticket_price?: string | null
          ticket_url?: string | null
          title?: string
          type?: Database["public"]["Enums"]["listing_type"]
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "listings_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      moderation_queue: {
        Row: {
          change_type: Database["public"]["Enums"]["moderation_change_type"]
          confirmed_by: string | null
          correction_note: string | null
          created_at: string
          id: string
          listing_id: string | null
          origin: string
          proposed_by: string | null
          proposed_data: Json | null
          proposed_reason: string | null
          status: Database["public"]["Enums"]["moderation_status"]
        }
        Insert: {
          change_type: Database["public"]["Enums"]["moderation_change_type"]
          confirmed_by?: string | null
          correction_note?: string | null
          created_at?: string
          id?: string
          listing_id?: string | null
          origin: string
          proposed_by?: string | null
          proposed_data?: Json | null
          proposed_reason?: string | null
          status?: Database["public"]["Enums"]["moderation_status"]
        }
        Update: {
          change_type?: Database["public"]["Enums"]["moderation_change_type"]
          confirmed_by?: string | null
          correction_note?: string | null
          created_at?: string
          id?: string
          listing_id?: string | null
          origin?: string
          proposed_by?: string | null
          proposed_data?: Json | null
          proposed_reason?: string | null
          status?: Database["public"]["Enums"]["moderation_status"]
        }
        Relationships: [
          {
            foreignKeyName: "moderation_queue_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
        ]
      }
      neighborhoods: {
        Row: {
          area_id: string
          id: string
          name: string
        }
        Insert: {
          area_id: string
          id?: string
          name: string
        }
        Update: {
          area_id?: string
          id?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "neighborhoods_area_id_fkey"
            columns: ["area_id"]
            isOneToOne: false
            referencedRelation: "areas"
            referencedColumns: ["id"]
          },
        ]
      }
      occurrence_exceptions: {
        Row: {
          id: string
          listing_id: string
          new_date: string | null
          new_start_time: string | null
          new_venue_id: string | null
          note: string | null
          original_date: string
          type: Database["public"]["Enums"]["exception_type"]
        }
        Insert: {
          id?: string
          listing_id: string
          new_date?: string | null
          new_start_time?: string | null
          new_venue_id?: string | null
          note?: string | null
          original_date: string
          type: Database["public"]["Enums"]["exception_type"]
        }
        Update: {
          id?: string
          listing_id?: string
          new_date?: string | null
          new_start_time?: string | null
          new_venue_id?: string | null
          note?: string | null
          original_date?: string
          type?: Database["public"]["Enums"]["exception_type"]
        }
        Relationships: [
          {
            foreignKeyName: "occurrence_exceptions_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "occurrence_exceptions_new_venue_id_fkey"
            columns: ["new_venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      recurrence_rules: {
        Row: {
          day_of_week: number
          frequency: Database["public"]["Enums"]["recurrence_frequency"]
          listing_id: string
          week_of_month: number | null
        }
        Insert: {
          day_of_week: number
          frequency: Database["public"]["Enums"]["recurrence_frequency"]
          listing_id: string
          week_of_month?: number | null
        }
        Update: {
          day_of_week?: number
          frequency?: Database["public"]["Enums"]["recurrence_frequency"]
          listing_id?: string
          week_of_month?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "recurrence_rules_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: true
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
        ]
      }
      venues: {
        Row: {
          address: string
          google_maps_url: string | null
          id: string
          name: string
          neighborhood_id: string
        }
        Insert: {
          address: string
          google_maps_url?: string | null
          id?: string
          name: string
          neighborhood_id: string
        }
        Update: {
          address?: string
          google_maps_url?: string | null
          id?: string
          name?: string
          neighborhood_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venues_neighborhood_id_fkey"
            columns: ["neighborhood_id"]
            isOneToOne: false
            referencedRelation: "neighborhoods"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      exception_type: "cancelled" | "modified"
      listing_status: "published" | "archived"
      listing_type: "mic" | "show"
      moderation_change_type: "new" | "update" | "cancellation"
      moderation_status:
        | "pending"
        | "rejection_proposed"
        | "approved"
        | "rejected"
      recurrence_frequency: "weekly" | "monthly"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      exception_type: ["cancelled", "modified"],
      listing_status: ["published", "archived"],
      listing_type: ["mic", "show"],
      moderation_change_type: ["new", "update", "cancellation"],
      moderation_status: [
        "pending",
        "rejection_proposed",
        "approved",
        "rejected",
      ],
      recurrence_frequency: ["weekly", "monthly"],
    },
  },
} as const

