import { describe, it, expect } from "vitest";
import {
  listingToProposedFields,
  parseProposedListingFields,
  findMissingRequiredFields,
} from "./moderation";
import type { ListingWithVenue } from "./listings";
import type { ProposedListingFields } from "./moderation";

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

  it("parses the three sign-up detail fields", () => {
    const fields = parseProposedListingFields(
      buildFormData({
        type: "mic",
        title: "A Mic",
        venueId: "c0000000-0000-0000-0000-000000000001",
        startTime: "20:00",
        signUpMethod: "slotted_online",
        signUpUrl: "https://slotted.co/some-mic",
        signUpOtherNote: "",
        signUpOpensAt: "",
      }),
    );

    expect(fields.signUpMethod).toBe("slotted_online");
    expect(fields.signUpUrl).toBe("https://slotted.co/some-mic");
    expect(fields.signUpOtherNote).toBeNull();
    expect(fields.signUpOpensAt).toBeNull();
  });

  it("parses 'every_other_week' into weekly with intervalWeeks 2 and the anchor date", () => {
    const fields = parseProposedListingFields(
      buildFormData({
        type: "mic",
        title: "A Mic",
        venueId: "c0000000-0000-0000-0000-000000000001",
        startTime: "20:00",
        frequency: "every_other_week",
        dayOfWeek: "2",
        anchorDate: "2026-09-01",
      }),
    );

    expect(fields.recurrence).toEqual({
      frequency: "weekly",
      intervalWeeks: 2,
      dayOfWeek: 2,
      weekOfMonth: null,
      anchorDate: "2026-09-01",
    });
  });

  it("parses plain 'weekly' into intervalWeeks 1 with a null anchor date", () => {
    const fields = parseProposedListingFields(
      buildFormData({
        type: "mic",
        title: "A Mic",
        venueId: "c0000000-0000-0000-0000-000000000001",
        startTime: "20:00",
        frequency: "weekly",
        dayOfWeek: "3",
      }),
    );

    expect(fields.recurrence).toEqual({
      frequency: "weekly",
      intervalWeeks: 1,
      dayOfWeek: 3,
      weekOfMonth: null,
      anchorDate: null,
    });
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
      signUpOpensAt: null,
      signUpMethod: "first_come",
      signUpUrl: null,
      signUpOtherNote: null,
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
        intervalWeeks: 1,
        anchorDate: null,
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
      signUpOpensAt: null,
      signUpMethod: "first_come",
      signUpUrl: null,
      signUpOtherNote: null,
      costToPerform: "Free",
      ticketPrice: null,
      ticketUrl: null,
      recurrence: {
        frequency: "weekly",
        dayOfWeek: 2,
        weekOfMonth: null,
        intervalWeeks: 1,
        anchorDate: null,
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
      signUpOpensAt: null,
      signUpMethod: null,
      signUpUrl: null,
      signUpOtherNote: null,
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

describe("findMissingRequiredFields", () => {
  const baseFields: ProposedListingFields = {
    type: "mic",
    title: "A Mic",
    host: null,
    description: null,
    venueId: "c0000000-0000-0000-0000-000000000001",
    newVenue: null,
    startTime: "20:00",
    signUpMethod: null,
    signUpUrl: null,
    signUpOtherNote: null,
    signUpOpensAt: null,
    costToPerform: null,
    ticketPrice: null,
    ticketUrl: null,
    recurrence: null,
    oneOffDate: "2026-10-01",
  };

  it("requires signUpOtherNote when signUpMethod is hybrid_other", () => {
    const missing = findMissingRequiredFields({
      ...baseFields,
      signUpMethod: "hybrid_other",
      signUpOtherNote: null,
    });

    expect(missing).toContainEqual({
      field: "signUpOtherNote",
      label: "Sign-up explanation",
    });
  });

  it("does not require signUpOtherNote for other sign-up methods", () => {
    const missing = findMissingRequiredFields({
      ...baseFields,
      signUpMethod: "first_come",
      signUpOtherNote: null,
    });

    expect(missing).not.toContainEqual(
      expect.objectContaining({ field: "signUpOtherNote" }),
    );
  });

  it("does not require signUpOtherNote when hybrid_other has a non-empty note", () => {
    const missing = findMissingRequiredFields({
      ...baseFields,
      signUpMethod: "hybrid_other",
      signUpOtherNote: "Bucket for first half, list for second half",
    });

    expect(missing).not.toContainEqual(
      expect.objectContaining({ field: "signUpOtherNote" }),
    );
  });
  it("requires anchorDate when intervalWeeks is greater than 1", () => {
    const missing = findMissingRequiredFields({
      ...baseFields,
      recurrence: {
        frequency: "weekly",
        dayOfWeek: 2,
        weekOfMonth: null,
        intervalWeeks: 2,
        anchorDate: null,
      },
    });

    expect(missing).toContainEqual({
      field: "anchorDate",
      label: "Anchor date",
    });
  });

  it("does not require anchorDate for plain weekly (intervalWeeks 1)", () => {
    const missing = findMissingRequiredFields({
      ...baseFields,
      recurrence: {
        frequency: "weekly",
        dayOfWeek: 2,
        weekOfMonth: null,
        intervalWeeks: 1,
        anchorDate: null,
      },
    });

    expect(missing).not.toContainEqual(
      expect.objectContaining({ field: "anchorDate" }),
    );
  });

  it("requires weekOfMonth when frequency is monthly", () => {
    const missing = findMissingRequiredFields({
      ...baseFields,
      recurrence: {
        frequency: "monthly",
        dayOfWeek: 4,
        weekOfMonth: null,
        intervalWeeks: 1,
        anchorDate: null,
      },
    });

    expect(missing).toContainEqual({
      field: "weekOfMonth",
      label: "Week of month",
    });
  });

  it("does not require weekOfMonth for weekly", () => {
    const missing = findMissingRequiredFields({
      ...baseFields,
      recurrence: {
        frequency: "weekly",
        dayOfWeek: 2,
        weekOfMonth: null,
        intervalWeeks: 1,
        anchorDate: null,
      },
    });

    expect(missing).not.toContainEqual(
      expect.objectContaining({ field: "weekOfMonth" }),
    );
  });
});
