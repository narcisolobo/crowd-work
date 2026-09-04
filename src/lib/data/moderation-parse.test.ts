import { describe, it, expect } from "vitest";
import { parseProposedListingFields } from "./moderation";

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
