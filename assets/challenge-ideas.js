/* TorchHive challenge inspiration. These are editable suggestions, never bids.
   Twenty illustrative scenes each serve five related, distinct challenges.
   Round-robin ordering puts one entertaining opener from every scene first. */
window.TORCHHIVE_CHALLENGES = (function () {
  'use strict';
  var groups = [
    {
      scene: 'potato-palace', label: 'Potato royalty', focus: '66% 48%',
      alt: 'A potato on an elaborate miniature cardboard throne in a warm workshop.',
      items: [
        ['Build a throne for a potato.', 'Spend up to 60 minutes building an absurdly grand miniature throne for one potato from cardboard and craft scraps. Show the build and give the potato its royal reveal.'],
        ['Give a potato a penthouse.', 'Build a tiny cardboard apartment for a potato in 60 minutes, including a bed, a balcony and one unnecessary luxury. Show the finished rooms with the potato for scale.'],
        ['Send a potato down a tiny slide.', 'Build a low tabletop cardboard playground for a potato in 45 minutes. Give it a slide and a ramp, then test whether it can roll through both without help.'],
        ['Make five potatoes a museum.', 'Spend 60 minutes making five miniature displays for five ordinary potatoes using cardboard and household props. Give a tour in your own words and reveal the most elaborate exhibit.'],
        ['Potato bowling. Ten attempts.', 'Build a small floor-level bowling lane from cardboard with six empty paper tubes as pins. Roll one potato for ten attempts and show how its awkward shape affects the score.']
      ]
    },
    {
      scene: 'tiny-feast', label: 'Ridiculously small food', focus: '60% 56%',
      alt: 'Three tiny dishes plated on tablespoons beside normal-size cutlery.',
      items: [
        ['Cook a three-spoon dinner.', 'Make a miniature three-course meal with each course fitting on one tablespoon. Spend up to 60 minutes cooking and plating it, then show the tiny meal beside normal cutlery.'],
        ['A burger smaller than a coin.', 'Spend up to 60 minutes making a cooked miniature burger with bun, filling and toppings, smaller across than a large coin. Show the assembly and compare it with a normal burger bun.'],
        ['Make a picnic fit in a teacup.', 'Prepare three miniature picnic foods and arrange them in one clean teacup in 45 minutes. Use ordinary ingredients and show the final picnic with a full-size cup for comparison.'],
        ['Twelve layers. Two inches tall.', 'Build a miniature sandwich with twelve edible layers while keeping it under two inches tall. Spend no more than 45 minutes and reveal the cross-section with a ruler beside it.'],
        ['Make a tiny birthday cake.', 'In 60 minutes, assemble and decorate a miniature cake no wider than a small cookie. Use edible decorations, skip candles, and reveal it beside a normal dinner plate.']
      ]
    },
    {
      scene: 'sock-hoops', label: 'Laundry sports', focus: '70% 50%',
      alt: 'Colorful rolled socks flying toward a laundry basket in a home laundry room.',
      items: [
        ['Sink ten socks from one chair.', 'From a stable chair on the floor, toss rolled socks into a laundry basket across a clear room. Try to land ten in a row within 30 minutes and show the best streak and the misses.'],
        ['Build a sock bowling league.', 'Set up ten empty plastic bottles on your own floor and bowl with rolled socks for ten frames. Spend up to 45 minutes setting up and playing, with the score and best throw shown.'],
        ['Curl socks toward the bullseye.', 'Make a removable paper target on a clear indoor floor and slide rolled socks toward its center. Try three different sock sizes over 30 throws and compare which slides most accurately.'],
        ['Laundry trick shots, three ways.', 'Set up three reachable laundry-basket targets at floor or table height in your own space. Attempt a bank shot, a bounce shot and a straight shot with rolled socks for up to 45 minutes.'],
        ['Beat a homemade sock obstacle course.', 'Build a floor-level course with cardboard tunnels and cushions, then roll socks through it without touching the obstacles. Spend 45 minutes building and trying to complete one clean run.']
      ]
    },
    {
      scene: 'pasta-engineering', label: 'Pasta engineering', focus: '55% 48%',
      alt: 'A dry-spaghetti bridge holding a paper cup of coins between two supports.',
      items: [
        ['Make spaghetti hold 100 coins.', 'Build a tabletop bridge from dry spaghetti and craft glue, then add up to 100 coins gradually. Spend up to 60 minutes building and testing and show how many it holds before it bends or breaks.'],
        ['Build the tallest pasta tower.', 'Use one small packet of dry spaghetti and craft glue to build the tallest freestanding tower you can in 45 minutes. Measure it on camera and leave it standing for one minute.'],
        ['Make a pasta marble run.', 'Build a tabletop marble track with dry pasta as the main structural material. Add a bend and a short drop, then spend up to 60 minutes trying to get five marbles through in a row.'],
        ['Can a spaghetti wheel turn?', 'Spend up to 60 minutes making a hand-turned miniature wheel supported by a spaghetti frame. Add three tiny paper baskets and show whether it can turn once without falling apart.'],
        ['Float a spaghetti raft.', 'Build a small raft from dry pasta and craft glue, then test it in a shallow tray with coins as cargo. Spend up to 45 minutes and record how long it floats and what load it holds.']
      ]
    },
    {
      scene: 'chain-reaction', label: 'Overengineer it', focus: '62% 50%',
      alt: 'A homemade chain-reaction machine of ramps, marbles and dominoes ending at a desk bell.',
      items: [
        ['Overengineer ringing a bell.', 'Build a tabletop chain-reaction machine from household objects that ends by ringing a desk bell. Include at least five steps, spend up to 60 minutes, and show the best complete attempt and the failures.'],
        ['Make six steps deliver one marble.', 'Build a tabletop chain reaction with six distinct steps that sends one marble into a cup. Spend up to 60 minutes and show your most successful run without hiding the restarts.'],
        ['Raise a tiny flag with dominoes.', 'Use a row of dominoes, a low ramp and a simple string lever to raise a small blank paper flag. Build and test the chain in 60 minutes using only tabletop-scale moving parts.'],
        ['Close a book the complicated way.', 'Spend up to 60 minutes building a small chain-reaction device that gently closes a paperback book. Use at least four ordinary objects before the final step and show the full sequence.'],
        ['Make a marble start a domino spiral.', 'Arrange a tabletop domino spiral and build a short marble ramp that starts it. Spend 45 minutes setting it up, then film the entire attempt and show how many dominoes fall.']
      ]
    },
    {
      scene: 'breakfast-lab', label: 'Breakfast experiments', focus: '65% 52%',
      alt: 'A comically lopsided pancake face in a frying pan with breakfast ingredients nearby.',
      items: [
        ['Paint a portrait in pancake batter.', 'Use pancake batter to draw a recognizable face in a pan, then reveal the cooked result. Spend up to 45 minutes, show three attempts, and choose the funniest result in your own words.'],
        ['Make breakfast look like a landscape.', 'Spend 45 minutes arranging a fully cooked breakfast into an edible landscape with hills, a river and a tiny house. Show the ingredients, the assembly and the final overhead view.'],
        ['Turn waffles into a castle.', 'Build a small edible castle from waffles, fruit and other breakfast ingredients in 45 minutes. Include a gate and two towers, then reveal whether it can stand for a full minute.'],
        ['Can toast become a jigsaw?', 'Cut cooled toast into a simple six-piece puzzle, add an edible picture with toppings, mix the pieces and reassemble it. Spend up to 30 minutes and show the finished edible puzzle.'],
        ['Build a cereal domino chain.', 'Use cereal pieces that can stand on edge to build a tiny domino chain on a clean tray. Spend up to 30 minutes testing designs, then show the longest successful chain.']
      ]
    },
    {
      scene: 'chopstick-sort', label: 'Tiny tasks, big effort', focus: '60% 52%',
      alt: 'Chopsticks moving coins beside bowls, colorful buttons and dry beans.',
      items: [
        ['Sort 500 coins with chopsticks.', 'Try to sort 500 mixed coins into denominations using only chopsticks to move them. Stop after 60 minutes, show the timer and count how many you managed to sort.'],
        ['Move 100 beans without a spoon.', 'Transfer 100 dry beans between bowls using chopsticks, one at a time. Allow 30 minutes, count dropped beans separately, and show the final count and elapsed time.'],
        ['Make a button rainbow with chopsticks.', 'Use chopsticks to arrange a pile of colored buttons into a neat rainbow without moving them with your fingers. Spend up to 45 minutes and reveal the complete pattern from above.'],
        ['Build a sugar-cube tower with chopsticks.', 'Try to build a freestanding sugar-cube tower using chopsticks to place every cube. Spend 30 minutes, keep it at tabletop height, and show the tallest tower that stays up for ten seconds.'],
        ['Make a coin portrait, one piece at a time.', 'Arrange coins into a simple face or animal outline using chopsticks for every placement. Spend up to 60 minutes and reveal the design from overhead before counting the coins.']
      ]
    },
    {
      scene: 'cardboard-arcade', label: 'Cardboard arcade', focus: '62% 48%',
      alt: 'A handmade cardboard tabletop arcade with ramps, target holes and colorful balls.',
      items: [
        ['Turn a delivery box into an arcade.', 'Spend up to 60 minutes turning a plain cardboard box into a tabletop ball game with three target openings. Use soft balls, then play ten attempts and show what works and what jams.'],
        ['Build a cardboard pinball machine.', 'Make a tabletop cardboard pinball game with hand-operated flippers and a marble in 60 minutes. Keep the ball enclosed and show a full round plus the most ridiculous failure.'],
        ['Make a maze with a tilting box.', 'Build a marble maze inside a shallow cardboard box with at least five turns. Spend up to 45 minutes constructing it and try to complete it by tilting the box without touching the marble.'],
        ['Build a tiny claw machine.', 'Make a tabletop cardboard crane game using a hand-operated grabber or tongs and clean bottle caps as prizes. Spend 60 minutes on the build, then show ten prize-grabbing attempts.'],
        ['Make a cardboard coin-drop game.', 'Build a tabletop cardboard drop-board with small deflectors and catch compartments. Spend 45 minutes, drop twenty tokens one at a time and reveal which compartment collects the most.']
      ]
    },
    {
      scene: 'paper-flight', label: 'Paper flight school', focus: '58% 48%',
      alt: 'Large and small folded paper aircraft with a handmade paper target in a clear room.',
      items: [
        ['Make a paper plane bigger than the table.', 'Use large lightweight paper to fold an oversized paper airplane. Spend up to 60 minutes building it, then make five gentle test flights in a clear private area and measure the best distance.'],
        ['Three planes. One landing zone.', 'Fold three different paper airplane designs and give each ten throws toward one paper landing zone in a clear private area. Spend up to 45 minutes and compare accuracy and distance.'],
        ['Land a paper helicopter in a cup.', 'Make paper helicopters in three sizes and drop them from shoulder height toward a wide cup. Spend 30 minutes testing them and show which design lands closest most often.'],
        ['Make a paper boomerang return.', 'Fold a small paper boomerang and spend up to 45 minutes trying to make it return within arm reach in a clear private space. Show the design changes and the best attempt.'],
        ['Give a toy a paper parachute.', 'Build three paper or tissue parachutes for one small lightweight toy. Drop each from shoulder height over a clear floor, compare how gently it lands and keep the whole test under 45 minutes.']
      ]
    },
    {
      scene: 'garage-golf', label: 'Homemade mini golf', focus: '61% 50%',
      alt: 'A homemade miniature golf course with cardboard obstacles, a putter and a ball in a garage.',
      items: [
        ['Mini golf. Maximum obstacles.', 'Build a homemade mini-golf hole in your own garage with three cardboard obstacles. Spend up to 60 minutes building and trying for a hole in one, and show the best attempt.'],
        ['Make a putt pass through a windmill.', 'Build a small hand-turned cardboard windmill obstacle for an indoor putting lane. Spend up to 60 minutes building and testing it with gentle putts and show the first successful pass.'],
        ['Build three holes from one box.', 'Use one cardboard box to make three short floor-level mini-golf holes. Allow 60 minutes for the build and one round, then compare the easiest and hardest holes.'],
        ['Bank a putt around two corners.', 'Create a low-speed indoor putting course that requires two bank shots off cardboard guides. Spend 45 minutes tuning the angles and show how many attempts it takes to reach the cup.'],
        ['Make a miniature golf loop-the-loop.', 'Build a small tabletop cardboard loop for a marble-sized golf ball. Spend up to 60 minutes and test gentle hand-started rolls until one clears the loop or time runs out.']
      ]
    },
    {
      scene: 'pantry-restaurant', label: 'Pantry fine dining', focus: '63% 52%',
      alt: 'Humble pantry food plated like fine dining beside plain tins and groceries.',
      items: [
        ['Make a gas station feast.', 'Buy up to $20 of ordinary food at a nearby gas station and turn it into three restaurant-style courses at home. Show the receipt, the cooking and an unscripted taste test. Allow up to 90 minutes including travel.'],
        ['Give beans on toast a fancy makeover.', 'Use beans, toast and up to three pantry extras to plate a ridiculously elegant dinner. Spend 45 minutes and show the plain version beside your finished restaurant-style plate.'],
        ['Make leftovers look like three meals.', 'Choose suitable leftovers from your own fridge and turn the same ingredients into three different plated meals in 60 minutes. Reheat food properly and reveal the three results side by side.'],
        ['Cook with three ingredients only.', 'Choose three ordinary ingredients already on hand and make the best cooked meal you can in 45 minutes, with water, oil and seasoning allowed. Show the ingredients and give your own honest verdict.'],
        ['Build an edible skyline from lunch.', 'Use normal sandwich ingredients, crackers and vegetables to build a small edible city on a platter in 45 minutes. Include three different building shapes and reveal the skyline at table level.']
      ]
    },
    {
      scene: 'balloon-engineering', label: 'Balloon-powered nonsense', focus: '59% 48%',
      alt: 'A handmade cardboard car with bottle-cap wheels and a balloon motor on a tabletop track.',
      items: [
        ['Race a car powered by one balloon.', 'Build a small balloon-powered car from cardboard, straws and bottle-cap wheels. Spend 60 minutes building and testing, then measure the best distance across a clear private floor.'],
        ['Make a tiny balloon hovercraft.', 'Use a balloon and a smooth lightweight base to make a small tabletop hovercraft. Spend 45 minutes experimenting with the air outlet, then show its longest glide on a clear table.'],
        ['Send a balloon down a zipline.', 'Thread a straw onto a low indoor string and attach an inflated balloon to make a simple air-powered zipline. Spend 30 minutes testing three balloon sizes and compare their distances.'],
        ['Make a balloon-powered boat.', 'Build a small balloon-powered boat for a shallow tray of water. Spend up to 60 minutes and test whether you can make it travel straight from one end of the tray to the other.'],
        ['Build a tower that balances a balloon.', 'Use paper and tape to build a freestanding tabletop tower that supports an inflated balloon without tying the balloon down. Spend 45 minutes and show the tallest stable design.']
      ]
    },
    {
      scene: 'card-tower', label: 'Cards versus gravity', focus: '59% 45%',
      alt: 'A tall, precarious house of playing cards with loose cards scattered across a table.',
      items: [
        ['Build a card skyscraper. No tape.', 'Try to build the tallest freestanding playing-card tower you can in 60 minutes using no tape, glue or supports. Work from the floor or a normal table and show the tallest attempt, even if it collapses.'],
        ['Make a card bridge hold a coin.', 'Build a bridge from playing cards between two cups and try to support a coin in the middle. Spend 45 minutes on different folded and stacked designs, with no glue or tape.'],
        ['Turn a deck into a spiral collapse.', 'Stand or fold playing cards into a tabletop chain with a spiral section, then try to knock them all down with one touch. Spend 45 minutes and show the best uninterrupted run.'],
        ['Build an arch from playing cards.', 'Spend up to 45 minutes making a freestanding arch from a deck of cards with no tape or glue. Show the supports you remove and whether the arch remains standing for ten seconds.'],
        ['Rebuild a landmark with one deck.', 'Choose a familiar public landmark and make a recognizable tabletop version using one deck of playing cards in 60 minutes. No adhesive; reveal the reference and your best finished attempt.']
      ]
    },
    {
      scene: 'speed-clean', label: 'Chores with a catch', focus: '60% 54%',
      alt: 'A tiny toothbrush cleaning one square of a grubby patio tile, with larger brushes nearby.',
      items: [
        ['Clean a patio tile with a toothbrush.', 'Spend up to 45 minutes cleaning one small tile or a two-foot square of your own patio using a toothbrush and water. Show the effort and the before-and-after reveal.'],
        ['Rake leaves with a dinner fork.', 'Spend 30 minutes clearing fallen leaves from a small patch of your own yard using only a dinner fork. Keep the leaves for compost and reveal how much ground you actually cleared.'],
        ['Give one muddy tool a makeover.', 'Choose a small hand tool you own and spend 45 minutes cleaning it with ordinary brushes and soapy water. Avoid powered equipment and reveal the difference under the same lighting.'],
        ['Make a messy drawer satisfyingly neat.', 'Pick one cluttered drawer you own and organize it in 45 minutes using dividers made from scrap cardboard. Hide private documents and show a matching before-and-after view.'],
        ['Build a tiny cleaning tool, then test it.', 'Make a miniature hand-operated brush or dustpan from scrap materials in 30 minutes. Test it on a small patch of dry crumbs at home and compare its result with a normal cleaning tool.']
      ]
    },
    {
      scene: 'thrift-rescue', label: 'Trash-to-treasure reveal', focus: '62% 48%',
      alt: 'A scratched wooden thrift-store box being restored by hand with a brush and sanding block.',
      items: [
        ['Rescue the ugliest $10 thrift find.', 'Choose a small item for $10 or less at a nearby thrift shop and spend up to 90 minutes improving it at home. Avoid electrical repairs, film the project rather than shop customers, and reveal the before and after.'],
        ['Turn an empty tin into a desk upgrade.', 'Use one clean, edge-safe empty tin and leftover craft materials to make a useful desk organizer in 45 minutes. Show the starting rubbish and the finished object doing its job.'],
        ['Give an old frame a second job.', 'Take an unused picture frame you own and turn it into a small tray or tabletop organizer in 60 minutes. Use simple hand tools and show the object before and after its new purpose.'],
        ['Make a scrap-wood phone stand.', 'Use small offcuts and simple hand tools to make a stable phone stand in 60 minutes. Test it with an empty cardboard phone template before using a phone, and show both viewing angles.'],
        ['Make a shoebox look worth keeping.', 'Turn one plain shoebox into an attractive reusable storage box using leftover paper, fabric or paint in 60 minutes. Show the transformation and how the lid still fits.']
      ]
    },
    {
      scene: 'outdoor-quest', label: 'Take the long way', focus: '62% 48%',
      alt: 'An anonymous adult carrying a watermelon along a quiet woodland walking path.',
      items: [
        ['Take a watermelon for a walk.', 'Carry one watermelon on a gentle two-mile walking loop on public pedestrian paths, taking breaks as needed. Film the journey without live location details and cut it open after returning home.'],
        ['Walk five miles for one doughnut.', 'Walk a five-mile round trip on pedestrian routes to buy one doughnut. Film the journey and your honest verdict on whether it was worth the walk, without filming strangers closely or sharing a live location.'],
        ['Let a coin choose the next turn.', 'Take a 45-minute walk on public pedestrian routes, flipping a coin at safe junctions to choose left or right. Leave enough time to return and reveal the route as a simple non-identifying sketch afterward.'],
        ['Draw a dinosaur with a walk.', 'Plan a walking route of up to three miles on public paths so its trace resembles a dinosaur. Walk it and reveal only the finished shape afterward, with addresses and identifying map details removed.'],
        ['Find A to Z without using a sign.', 'Spend up to 60 minutes on a public walking route photographing natural shapes that resemble alphabet letters. Use no printed signs, avoid faces and private homes, and reveal how many letters you found.']
      ]
    },
    {
      scene: 'photo-tricks', label: 'Camera tricks', focus: '61% 48%',
      alt: 'A toy dinosaur and everyday desk objects staged for a dramatic forced-perspective photograph.',
      items: [
        ['Make a toy look like a movie monster.', 'Spend 45 minutes photographing one small toy against everyday objects so it looks enormous, using only practical perspective tricks. Reveal the finished shot and pull back to show the tiny setup.'],
        ['Make an orange look like a planet.', 'Use an orange, a dark background and a desk lamp to create a convincing space photograph in 45 minutes. Keep lamps away from flammable props and reveal the full tabletop setup afterward.'],
        ['Turn a mug into a mountain.', 'Spend up to 45 minutes making a landscape photograph from a mug, paper and other small household objects. Use forced perspective and reveal the ordinary objects behind the finished image.'],
        ['Make five different shadows from one object.', 'Choose one household object and use a small lamp to create five distinct-looking shadow pictures in 30 minutes. Show the camera view and how changing the angle created each result.'],
        ['Make a reflection look impossible.', 'Use a small mirror and ordinary objects on a table to make one puzzling reflection photograph in 45 minutes. No compositing; reveal the camera angle and mirror position at the end.']
      ]
    },
    {
      scene: 'stop-motion', label: 'Tiny movie studio', focus: '61% 48%',
      alt: 'A small camera on a tabletop tripod filming everyday objects arranged for a stop-motion scene.',
      items: [
        ['Make toast into a silent thriller.', 'Film and edit a 30-second silent suspense scene about making toast, using safe normal kitchen actions, dramatic close-ups and your own creative choices. Spend up to 60 minutes; no required dialogue or costumes.'],
        ['Make desk objects tidy themselves.', 'Create a 15-second stop-motion clip in which pens, paper and other desk objects appear to put themselves away. Spend 60 minutes shooting and editing, then show the finished clip and one behind-the-scenes view.'],
        ['Make a snack assemble itself backward.', 'Film a simple food assembly in reverse order, then reverse the footage so the snack seems to build itself. Keep everything clean and edible, spend 45 minutes and reveal the filming trick.'],
        ['Make a paper boat sail across a desk.', 'Create a short stop-motion journey for a paper boat through a tabletop scene built from paper. Spend up to 60 minutes and show the complete film followed by how you moved the boat.'],
        ['Teleport a mug with camera cuts.', 'Make a 20-second video in which an empty mug appears to move between five places on your own table using simple cuts. No dangerous stunts or extra people; reveal one cut before and after editing.']
      ]
    },
    {
      scene: 'everyday-invention', label: 'Unnecessary inventions', focus: '61% 50%',
      alt: 'An elaborate hand-operated cardboard snack dispenser on a home workbench.',
      items: [
        ['Build a machine for one snack.', 'Spend 60 minutes making a hand-operated cardboard device that delivers one small wrapped snack into a tray. Make it unnecessarily elaborate, then show five attempts and whether it ever works reliably.'],
        ['Overbuild a pencil holder.', 'Use scrap cardboard and small offcuts to make a pencil holder with one moving compartment or secret drawer in 60 minutes. Show its mechanism and test whether it still holds pencils properly.'],
        ['Make a tiny crane lift a spoon.', 'Build a small hand-operated tabletop crane from cardboard, string and craft sticks in 60 minutes. Try to move a teaspoon between two marked spots and show how much the structure bends.'],
        ['Turn a page without touching the book.', 'Spend up to 60 minutes building a simple hand-operated page-turning gadget from household materials. Test it on a paperback you own and show five attempts without touching the page directly.'],
        ['Build a marble elevator.', 'Use cardboard and a hand crank or string to lift one marble from table level to a short raised platform. Spend 60 minutes on the build and show five full lift-and-release cycles.']
      ]
    },
    {
      scene: 'paper-city', label: 'Paper worlds', focus: '61% 48%',
      alt: 'A miniature city of folded paper buildings and origami shapes beside a small desk fan.',
      items: [
        ['Build a paper city. Test the wind.', 'Build a small city from recycled paper in 45 minutes, then test it with a desk fan on its lowest setting. Show which building design stays upright longest and collect the paper afterward.'],
        ['Make a paper hat for a rubber duck.', 'Fold three different tiny paper hats for a toy rubber duck in 30 minutes. Nothing goes on your own head; show the designs on the toy and choose your favorite in your own words.'],
        ['One sheet. One impossible-looking sculpture.', 'Use one sheet of paper, with cutting and folding allowed, to make a freestanding sculpture in 45 minutes. Show it from three angles and reveal how it came from the single sheet.'],
        ['Build a city that folds flat.', 'Spend 60 minutes making a miniature pop-up paper streetscape that folds closed and opens again. Show the construction and test it through five opening-and-closing cycles.'],
        ['Make a flower bigger than its vase.', 'Use clean recycled paper to make one oversized paper flower in 45 minutes. Put it in a small stable vase you own and reveal the size contrast beside a normal pencil.']
      ]
    }
  ];
  var scenes = {}, ideas = [];
  groups.forEach(function (group) {
    scenes[group.scene] = {
      label: group.label,
      src: '/assets/challenges/' + group.scene + '.webp',
      thumb: '/assets/challenges/' + group.scene + '-thumb.webp',
      alt: group.alt,
      focus: group.focus
    };
  });
  for (var round = 0; round < 5; round++) {
    groups.forEach(function (group) {
      var item = group.items[round];
      ideas.push({
        id: group.scene + '-' + (round + 1), scene: group.scene,
        title: item[0], task: item[1], chip: item[0].replace(/\.$/, ''),
        starter: round === 0
      });
    });
  }
  return { version: '2026-11-15', scenes: scenes, ideas: ideas, starterCount: groups.length };
})();
