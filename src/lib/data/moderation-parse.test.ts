import { describe, it, expect } from "vitest";
import { listingToProposedFields, parseProposedListingFields } from "./moderation";
import type { ListingWithVenue } from "./listings";

function buildFormData(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

describe("parseProposedListingFields", () => {
  it("parses a real venue id into venueId, with newVenue null", () => {
    const fields = parseProposedListingFields(
      buildFormData({
        type: "mic",
        title: "A Mic",
        venueId: "c0000000-0000-0000-0000-000000000001",
        startTime: "20:00",
      }),
    );

    expect(fields.venueId).toBe("c0000000-0000-0000-0000-000000000001");
    expect(fields.newVenue).toBeNull();
  });

  it("parses the '__new__' sentinel into a newVenue object, with venueId null", () => {
    const fields = parseProposedListingFields(
      buildFormData({
        type: "show",
        title: "A Show",
        venueId: "__new__",
        newVenueName: "The Back Room",
        newVenueAddress: "123 Fake St, Los Angeles, CA",
        newVenueNeighborhoodId: "b0000000-0000-0000-0000-000000000002",
        newVenueGoogleMapsUrl: "https://maps.google.com/?q=back+room",
        startTime: "21:00",
      }),
    );

    expect(fields.venueId).toBeNull();
    expect(fields.newVenue).toEqual({
      name: "The Back Room",
      address: "123 Fake St, Los Angeles, CA",
      neighborhoodId: "b0000000-0000-0000-0000-000000000002",
      googleMapsUrl: "https://maps.google.com/?q=back+room",
    });
  });

  it("defaults an absent googleMapsUrl to null on a new venue", () => {
    const fields = parseProposedListingFields(
      buildFormData({
        type: "mic",
        title: "A Mic",
        venueId: "__new__",
        newVenueName: "The Back Room",
        newVenueAddress: "123 Fake St, Los Angeles, CA",
        newVenueNeighborhoodId: "b0000000-0000-0000-0000-000000000002",
        startTime: "20:00",
      }),
    );

    expect(fields.newVenue?.googleMapsUrl).toBeNull();
  });
});

describe("listingToProposedFields", () => {
  it("maps a recurring listing's current values, with newVenue null", () => {
    const listing: ListingWithVenue = {
      id: "d0000000-0000-0000-0000-000000000001",
      type: "mic",
      title: "The Weekly Mic",
      host: "Jane Host",
      description: "A great mic.",
      startTime: "20:00",
      signUpMethod: "Sign-up list at the door",
      costToPerform: "Free",
      ticketPrice: null,
      ticketUrl: null,
      venue: {
        id: "c0000000-0000-0000-0000-000000000001",
        name: "The Virgil",
        address: "4519 Santa Monica Blvd, Los Angeles, CA",
        googleMapsUrl: null,
        neighborhoodId: "b0000000-0000-0000-0000-000000000001",
        areaIds: ["a0000000-0000-0000-0000-000000000001"],
      },
      recurrenceRule: {
        frequency: "weekly",
        dayOfWeek: 2,
        weekOfMonth: null,
      },
      oneOffDate: null,
    };

    expect(listingToProposedFields(listing)).toEqual({
      type: "mic",
      title: "The Weekly Mic",
      host: "Jane Host",
      description: "A great mic.",
      venueId: "c0000000-0000-0000-0000-000000000001",
      newVenue: null,
      startTime: "20:00",
      signUpMethod: "Sign-up list at the door",
      costToPerform: "Free",
      ticketPrice: null,
      ticketUrl: null,
      recurrence: {
        frequency: "weekly",
        dayOfWeek: 2,
        weekOfMonth: null,
      },
      oneOffDate: null,
    });
  });

  it("carries through a null recurrence for a one-off listing", () => {
    const listing: ListingWithVenue = {
      id: "d0000000-0000-0000-0000-000000000002",
      type: "show",
      title: "One Night Only",
      host: null,
      description: null,
      startTime: "21:00",
      signUpMethod: null,
      costToPerform: null,
      ticketPrice: "$15",
      ticketUrl: "https://example.com/tickets",
      venue: {
        id: "c0000000-0000-0000-0000-000000000001",
        name: "The Virgil",
        address: "4519 Santa Monica Blvd, Los Angeles, CA",
        googleMapsUrl: null,
        neighborhoodId: "b0000000-0000-0000-0000-000000000001",
        areaIds: ["a0000000-0000-0000-0000-000000000001"],
      },
      recurrenceRule: null,
      oneOffDate: "2026-10-01",
    };

    const result = listingToProposedFields(listing);
    expect(result.recurrence).toBeNull();
    expect(result.oneOffDate).toBe("2026-10-01");
    expect(result.newVenue).toBeNull();
  });
});
