-- Venues sourced from https://www.ianirarousso.com/la-open-mic-lists,
-- reviewed and address/neighborhood-verified by hand (see
-- data/open-mic-venues-review.csv and data/open-mics-raw-data.csv for
-- the working notes). Excludes venues outside the neighborhoods
-- taxonomy's LA-County scope (Long Beach, Santa Ana, Ontario).
--
-- Idempotent via NOT EXISTS rather than ON CONFLICT, since venues has
-- no natural unique key besides id. Safe to run against local dev and
-- once against production, same as the areas/neighborhoods seed.

insert into venues (name, address, neighborhood_id, google_maps_url)
select v.name, v.address, n.id, v.maps_link
from (values
  ('The Comedy Store', '8433 Sunset Blvd, West Hollywood, CA 90069', 'West Hollywood', 'https://maps.app.goo.gl/aYpQysUaK6xiwsph6'),
  ('The Glendale Room', '127 N Artsakh Ave, Glendale, CA 91206', 'Glendale', 'https://maps.app.goo.gl/L8py5889CbMDiSt59'),
  ('Tao Comedy Studio', '131 S Western Ave, Los Angeles, CA 90004', 'Koreatown', 'https://maps.app.goo.gl/6fgtc6CDg4mSfuGa6'),
  ('Park La Brea Activities Center and Theater', '475 S Curson Ave, Los Angeles, CA 90036', 'Mid-Wilshire', 'https://maps.app.goo.gl/q8UBXFGfkBYQxvcL9'),
  ('The Comedy Chateau', '4615 Lankershim Blvd, North Hollywood, CA 91602', 'North Hollywood', 'https://maps.app.goo.gl/UTP8rdFARBRoYDcD9'),
  ('Brews Brothers Brewpub (Burbank)', '3000 W Olive Ave, Burbank, CA 91505', 'Burbank', 'https://maps.app.goo.gl/uCdmNFPwUVML5TJd6'),
  ('Brews Brothers (North Hollywood)', '5140 Lankershim Blvd, North Hollywood, CA 91601', 'North Hollywood', 'https://maps.app.goo.gl/7qTD5MqTANfovpkh9'),
  ('Sal''s Pub & Grill', '22033 Sherman Way, Canoga Park, CA 91303', 'Canoga Park', 'https://maps.app.goo.gl/TTGWg53K6xoZiZ9N9'),
  ('Liquid Zoo', '7214 Sepulveda Blvd, Van Nuys, CA 91405', 'Van Nuys', 'https://maps.app.goo.gl/eaYdgKamB7HDy48z8'),
  ('The Pack Theater', '1615 N Vermont Ave, Los Angeles, CA 90027', 'East Hollywood', 'https://maps.app.goo.gl/wUVYUgz8ZzEyHZnZ7'),
  ('Nico''s Wines (Baby Battista)', '3111 Glendale Blvd #2, Los Angeles, CA 90039', 'Atwater Village', 'https://maps.app.goo.gl/Dsg4noWq8qYSn9fJ7'),
  ('Petty Cash Studios', '8949 Sunset Blvd Ste 203, West Hollywood, CA 90069', 'West Hollywood', 'https://maps.app.goo.gl/9zbegKLCuem4QS3X8'),
  ('The Blue Door Theater', '9617 Venice Blvd., Culver City, CA 90232', 'Culver City', 'https://maps.app.goo.gl/rgAfRutNf7Yqv2MY8'),
  ('The Elysian Theater', '1944 Riverside Dr, Los Angeles, CA 90039', 'Echo Park', 'https://maps.app.goo.gl/aMDotVuhz5HKmtbEA'),
  ('Boomtown Brewery', '700 Jackson St, Los Angeles, CA 90012', 'Downtown', 'https://maps.app.goo.gl/BtWKgaQXVJd1eZXG6'),
  ('The CanTiki', '11100 Magnolia Blvd, North Hollywood, CA 91601', 'North Hollywood', 'https://maps.app.goo.gl/25gxUGFvFXHZvR2z5'),
  ('The Nitecap', '2200 W Burbank Blvd B, Burbank, CA 91506', 'Burbank', 'https://maps.app.goo.gl/yAy94r1PxEbiKzm99'),
  ('Universal Bar & Grill', '4093 Lankershim Blvd, North Hollywood, CA 91602', 'North Hollywood', 'https://maps.app.goo.gl/7KXFW6RD1pkrSF9n6'),
  ('Mattie''s WeHo', '8900 Santa Monica Blvd, West Hollywood, CA 90069', 'West Hollywood', 'https://maps.app.goo.gl/eYTP8U4HZ9MDjgBF8'),
  ('Lyric Hyperion Theater & Cafe', '2106 Hyperion Ave, Los Angeles, CA 90027', 'Silver Lake', 'https://maps.app.goo.gl/FmbUEkJs6Tn9zQRJ8'),
  ('Laugh Factory (Hollywood)', '8001 Sunset Blvd, Los Angeles, CA 90046', 'Hollywood Hills West', 'https://maps.app.goo.gl/Evyb26wSfejnnrya6'),
  ('The Improv (Hollywood)', '8162 Melrose Ave, Los Angeles, CA 90046', 'Beverly Grove', 'https://maps.app.goo.gl/PJnmtj9657wyVgGF6'),
  ('Kibitz Room (Canter''s Deli)', '419 N Fairfax Ave, Los Angeles, CA 90048', 'Beverly Grove', 'https://maps.app.goo.gl/6rCq6Mghf8HDifjd6'),
  ('Cahuenga General Store', '5510 Cahuenga Blvd, North Hollywood, CA 91601', 'North Hollywood', 'https://maps.app.goo.gl/9mH2cFLg22i941aW9'),
  ('Relentless Spirits & Brewing', '2133 Colorado Blvd, Los Angeles, CA 90041', 'Eagle Rock', 'https://maps.app.goo.gl/hJpr1CiW33ihheLv8'),
  ('Kavahana Bar', '306 Pico Blvd, Santa Monica, CA 90405', 'Santa Monica', 'https://maps.app.goo.gl/EfZHNLuRtanYutJEA'),
  ('Stand-Up Comedy Club', '9831 Belmont St, Bellflower, CA 90706', 'Bellflower', 'https://maps.app.goo.gl/G2u52e8P76r2t1aX7'),
  ('Three Weavers Brewing Company', '1031 W Manchester Blvd A-B, Inglewood, CA 90301', 'Inglewood', 'https://maps.app.goo.gl/ocGWF27U9gNPADWu8'),
  ('UCB Annex', '1925 N Bronson Ave, Los Angeles, CA 90068', 'Hollywood Hills', 'https://maps.app.goo.gl/ShEuZuonaz6RQCNK7'),
  ('The Mexican Village Restaurant', '3668 Beverly Blvd, Los Angeles, CA 90004', 'Koreatown', 'https://maps.app.goo.gl/dZWQe5UxmNjSXW8QA'),
  ('Viibz', '10863 Magnolia Blvd, North Hollywood, CA 91601', 'North Hollywood', 'https://maps.app.goo.gl/Tck4uFP1Y7vRM3Rz7'),
  ('Sunset Rooftop', '6099 Sunset Blvd, Los Angeles, CA 90028', 'Hollywood', 'https://maps.app.goo.gl/WsGtjEgUHXpDsxYj6'),
  ('Rhythm & Bleu', '2064 Sawtelle Blvd, Los Angeles, CA 90025', 'Sawtelle', 'https://maps.app.goo.gl/PsuSZRzXyYU5ToC79'),
  ('Golden Gopher', '417 W 8th St, Los Angeles, CA 90014', 'Downtown', 'https://maps.app.goo.gl/GqQqAipHVL5SjKPb9'),
  ('The Woods', '1533 N La Brea Ave, Los Angeles, CA 90028', 'Hollywood', 'https://maps.app.goo.gl/tQtwQKc7FifZWEZ97'),
  ('Chatterbox', '943 N Citrus Ave, Covina, CA 91722', 'Covina', 'https://maps.app.goo.gl/vJ8akE1yCRLq4yqD6'),
  ('Maui Sugar Mill Saloon', '18389 Ventura Blvd, Tarzana, CA 91356', 'Tarzana', 'https://maps.app.goo.gl/XupihkMyaAw9aAtL8'),
  ('Westside Comedy Theater', '1323-A 3rd St, Santa Monica, CA 90401', 'Santa Monica', 'https://maps.app.goo.gl/zugLVRaa5a3myf21A'),
  ('The Activist Kitchen Creative Space', '669 Heliotrope Dr, Los Angeles, CA 90004', 'East Hollywood', 'https://maps.app.goo.gl/G3Br1f5PB3XHLuAm8'),
  ('HAHA Comedy Club', '4712 Lankershim Blvd, North Hollywood, CA 91602', 'North Hollywood', 'https://maps.app.goo.gl/VMa1qYBPeKCwtMi3A'),
  ('Mar Vista Branch Library', '12006 Venice Blvd., Los Angeles, CA 90066', 'Mar Vista', 'https://maps.app.goo.gl/yHVjAuxXiY5mJT8k9'),
  ('Chevalier''s Books', '133 N Larchmont Blvd, Los Angeles, CA 90004', 'Larchmont', 'https://maps.app.goo.gl/ZRzqnSevhgqgmsoY8'),
  ('Bad Ladder', '1514 N Gardner St, Los Angeles, CA 90046', 'Hollywood', 'https://maps.app.goo.gl/ymojQ6KFBntUsgbr8'),
  ('The Barkley Restaurant & Bar', '1400 Huntington Dr, South Pasadena, CA 91030', 'South Pasadena', 'https://maps.app.goo.gl/vKHE8yz9WZNBMt9h9'),
  ('The First Amendment', '697 E Foothill Blvd, Claremont, CA 91711', 'Claremont', 'https://maps.app.goo.gl/AcHeXpdxkvmg7Hq66'),
  ('Close Up Kuts', '1130 Centinela Ave STE B, Inglewood, CA 90302', 'Inglewood', 'https://maps.app.goo.gl/i8or1XzAXNPpSNoS7'),
  ('The SiLA Clubhouse', '1204 San Julian St, Los Angeles, CA 90015', 'Downtown', 'https://maps.app.goo.gl/u98NWMUQvkbscnoc7'),
  ('The Ice House', '24 N Mentor Ave, Pasadena, CA 91106', 'Pasadena', 'https://maps.app.goo.gl/JhzMLMw1WhMXpBTJA'),
  ('The FanaticSalon Theater | Culver City Comedy Club', '3815 Sawtelle Blvd, Los Angeles, CA 90066', 'Culver City', 'https://maps.app.goo.gl/trjPQg9BfzbeQBPdA'),
  ('Cathedral Sanctuary (Immanuel Presbyterian Church)', '3300 Wilshire Blvd, Los Angeles, CA 90010', 'Koreatown', 'https://maps.app.goo.gl/69BNWmzwybySrnZi8'),
  ('Corbin Bowl', '19616 Ventura Blvd, Tarzana, CA 91356', 'Tarzana', 'https://maps.app.goo.gl/d6539sQepYDZ4Rfn7'),
  ('See Ya There Comedy', '10940 Ophir Dr Los Angeles CA 90024', 'Westwood', 'https://maps.app.goo.gl/xzdwSiFscHCtivCf7'),
  ('Café Tropical', '2900 Sunset Blvd, Los Angeles, CA 90026', 'Silver Lake', 'https://maps.app.goo.gl/mncWVDbZ3vXAhH3y8'),
  ('The Clubhouse', '1607 N Vermont Ave, Los Angeles, CA 90027', 'East Hollywood', 'https://maps.app.goo.gl/MCQ6f3CriCwJAqjM7'),
  ('Digital Debris', '2646 N Figueroa St, Los Angeles, CA 90065', 'Cypress Park', 'https://maps.app.goo.gl/ki346WjZ8E2YrgsC7'),
  ('Mofongos', '5757 Lankershim Blvd, North Hollywood, CA 91601', 'North Hollywood', 'https://maps.app.goo.gl/BwSHB1MzXBuQCc2Q8'),
  ('The NoHo Diner', '11329 Magnolia Blvd, North Hollywood, CA 91601', 'North Hollywood', 'https://maps.app.goo.gl/bzzoaAoMo87p3wt19'),
  ('The Broadwater Second Stage', '6320 Santa Monica Blvd, Los Angeles, CA 90038', 'Hollywood', 'https://maps.app.goo.gl/jqF2UD8viKG1YViP8'),
  ('Melody Bar & Grill', '9132 S Sepulveda Blvd, Los Angeles, CA 90045', 'Westchester', 'https://maps.app.goo.gl/BffNN2fAHdKg8Txf7')
) as v(name, address, neighborhood_name, maps_link)
join neighborhoods n on n.name = v.neighborhood_name
where not exists (
  select 1 from venues existing where existing.name = v.name
);
