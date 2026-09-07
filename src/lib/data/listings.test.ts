import { describe, it, expect } from "vitest";
import {
  getNeighborhoods,
  getAreas,
  getPublishedListings,
  getListingTitles,
} from "./listings";
import { signInTestModerator } from "./moderation-test-helpers";

describe("getNeighborhoods", () => {
  it("returns neighborhoods ordered by name, each with its area ids", async () => {
    const [neighborhoods, areas] = await Promise.all([
      getNeighborhoods(),
      getAreas(),
    ]);
    const centralLA = areas.find((a) => a.name === "Central L.A.");
    expect(centralLA).toBeDefined();

    const losFeliz = neighborhoods.find(
      (n) => n.id === "b0000000-0000-0000-0000-000000000001",
    );
    expect(losFeliz?.name).toBe("Los Feliz");
    expect(losFeliz?.areaIds).toEqual(
      expect.arrayContaining([
        centralLA!.id,
        "a0000000-0000-0000-0000-000000000001",
      ]),
    );
    expect(losFeliz?.areaIds).toHaveLength(2);

    const santaMonica = neighborhoods.find(
      (n) => n.id === "b0000000-0000-0000-0000-000000000003",
    );
    expect(santaMonica?.areaIds).toEqual([
      "a0000000-0000-0000-0000-000000000002",
    ]);

    const names = neighborhoods.map((n) => n.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe("getPublishedListings", () => {
  it("returns every tagged area for a listing in a dual-tagged neighborhood", async () => {
    const [listings, areas] = await Promise.all([
      getPublishedListings(),
      getAreas(),
    ]);
    const centralLA = areas.find((a) => a.name === "Central L.A.");
    expect(centralLA).toBeDefined();

    // "The Virgil" (seeded venue) sits in Silver Lake, which is tagged
    // both Central L.A. (official) and Eastside (colloquial, fixed uuid).
    const tuesdayMic = listings.find((l) => l.title === "Tuesday Night Mic");
    expect(tuesdayMic).toBeDefined();
    expect(tuesdayMic!.venue.areaIds).toEqual(
      expect.arrayContaining([
        centralLA!.id,
        "a0000000-0000-0000-0000-000000000001",
      ]),
    );
    expect(tuesdayMic!.venue.areaIds).toHaveLength(2);
  });
});

describe("getListingTitles", () => {
  it("resolves listing ids to their titles", async () => {
    const moderator1 = await signInTestModerator(1);
    // "Tuesday Night Mic", seeded in supabase/seed.sql.
    const EXISTING_LISTING_ID = "d0000000-0000-0000-0000-000000000001";

    const titles = await getListingTitles(moderator1, [EXISTING_LISTING_ID]);

    expect(titles[EXISTING_LISTING_ID]).toBe("Tuesday Night Mic");
  });

  it("returns an empty object for an empty id list", async () => {
    const moderator1 = await signInTestModerator(1);
    const titles = await getListingTitles(moderator1, []);
    expect(titles).toEqual({});
  });
});
