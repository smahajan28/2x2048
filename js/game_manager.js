// This contains the bulk of the modified game logic to support n players, where n=2 currently. The networking code would still need to be updated to actually support more than 2 players
function GameManager(size, InputManager, Actuator, ScoreManager, PeerID, player, state) {
  this.size           = size; // Size of the grid
  this.inputManager   = new InputManager;
  this.scoreManager   = new ScoreManager;
  this.actuator       = new Actuator;
  this.players        = 2;
  this.peerID         = PeerID;
  this.state          = state || null;
  this.player         = player;

  this.startTiles   = 2;

  this.inputManager.on("move", this.move.bind(this));
  this.inputManager.on("restart", this.restart.bind(this));
  this.inputManager.on("keepPlaying", this.keepPlaying.bind(this));

  this.setup();
}

// Restart the game
GameManager.prototype.restart = function () {
  this.actuator.continue();
  this.setup();

  if (this.state)
    window.connection.send({connected: true});
  else
    window.connection.send({state: { grid: this.grid.serialize(), currentPlayer: this.currentPlayer, scores: this.scores }});
};

// Keep playing after winning
GameManager.prototype.keepPlaying = function () {
  this.keepPlaying = true;
  this.actuator.continue();
};

GameManager.prototype.isGameTerminated = function () {
  if (this.over || (this.won && !this.keepPlaying)) {
    return true;
  } else {
    return false;
  }
};

// Set up the game
GameManager.prototype.setup = function () {
  this.grid        = new Grid(this.size);

  this.score       = 0;
  this.over        = false;
  this.won         = false;
  this.winners      = null;
  this.keepPlaying = false;
  this.scores      = [];
  this.currentPlayer = 0; // We've added this variable to keep track of the current player who's taking a turn

  if (this.state) {
    this.currentPlayer = this.state.currentPlayer;
    this.scores = this.state.scores;
  }

  // initialize scores
  if (this.scores.length === 0)
    for (var x = 0; x < this.players; x++) {
      this.scores[x] = 0;
    }

  // Add the initial tiles
  this.addStartTiles();

  // Update the actuator
  this.actuate();
};

// Set up the initial tiles to start the game with
GameManager.prototype.addStartTiles = function () {
  if (this.state) {
    this.grid.deserialize(this.state.grid);
  } else {
    for (var i = 0; i < this.players; i++) {
      this.addRandomTile();
      this.currentPlayer++; // We're splitting the available tiles between two players
    }
    this.currentPlayer = 0;
  }
};

// Adds a tile in a random position
GameManager.prototype.addRandomTile = function (seed) {
  var self = this;
  if (this.grid.cellsAvailable()) {
    var seed = (seed ? seed : Math.random());
    var value = seed < 0.9 ? 2 : 4;
    var tile = new Tile(this.grid.randomAvailableCell(seed), value, this.currentPlayer);
    this.grid.insertTile(tile);
    this.scores[tile.player] += tile.value; // The total score is the sum of all tiles owned by a specific player
  }
};

GameManager.prototype.receiveSeed = function(seed) {
  this.seed = (this.seed + seed) / 2;
};

// Adds a tile in a specific position
GameManager.prototype.addTile = function (position, value) {
    var value = Math.random() < 0.9 ? 2 : 4;
    var tile = new Tile(this.grid.randomAvailableCell(), value, this.currentPlayer);

    this.grid.insertTile(tile);
};

// Sends the updated grid to the actuator
GameManager.prototype.actuate = function () {
  if (this.scoreManager.get() < this.score) {
    this.scoreManager.set(this.score);
  }

  this.actuator.actuate(this.grid, {
    scores:     this.scores,
    over:       this.over,
    won:        this.won,
    winners:    this.winners,
    bestScore:  this.scoreManager.get(),
    terminated: this.isGameTerminated(),
    roomID:     this.peerID,
    currentPlayer: this.currentPlayer,
    player:     this.player
  });

};

// Save all tile positions and remove merger info
GameManager.prototype.prepareTiles = function () {
  this.grid.eachCell(function (x, y, tile) {
    if (tile) {
      tile.mergedFrom = null;
      tile.savePosition();
    }
  });
};

// Move a tile and its representation
GameManager.prototype.moveTile = function (tile, cell) {
  this.grid.cells[tile.x][tile.y] = null;
  this.grid.cells[cell.x][cell.y] = tile;
  tile.updatePosition(cell);
};

// Move tiles on the grid in the specified direction
GameManager.prototype.move = function (direction, nosend) {
  if (this.continueGame)
    return;

  if (this.currentPlayer != this.player && !nosend) {
    return;
  }

  // 0: up, 1: right, 2:down, 3: left
  var self = this;

  if (this.isGameTerminated()) return; // Don't do anything if the game's over

  var cell, tile;

  var vector     = this.getVector(direction);
  var traversals = this.buildTraversals(vector);
  var moved      = false;

  // Save the current tile positions and remove merger information
  this.prepareTiles();

  // Traverse the grid in the right direction and move tiles
  traversals.x.forEach(function (x) {
    traversals.y.forEach(function (y) {
      cell = { x: x, y: y };
      tile = self.grid.cellContent(cell);

      if (tile) {
        var positions = self.findFarthestPosition(cell, vector);
        var next      = self.grid.cellContent(positions.next);

        // Only one merger per row traversal?
        if (next && next.value === tile.value && !next.mergedFrom) {
          var merged = new Tile(positions.next, tile.value * 2, (tile.player === self.currentPlayer || next.player === self.currentPlayer) ? self.currentPlayer : tile.player); // Merging logic here gives ownership of merged tile to the current player who did the merging
          merged.mergedFrom = [tile, next];

          self.grid.insertTile(merged);
          self.grid.removeTile(tile);

          // Converge the two tiles' positions
          tile.updatePosition(positions.next);

          // Update the score
          if (next.player !== tile.player) {
            self.scores[next.player] += (next.player === merged.player ? 1 : -1) * tile.value;
            self.scores[tile.player] += (tile.player === merged.player ? 1 : -1) * tile.value;
          }
          self.score += merged.value;

          // The mighty 2048 tile
          if (merged.value === 2048) {
            self.won = true;
            self.winners = [self.currentPlayer];
          }
        } else {
          self.moveTile(tile, positions.farthest);
        }

        if (!self.positionsEqual(cell, tile)) {
          moved = true; // The tile moved from its original cell!
        }
      }
    });
  });

  if (moved) {
    this.currentPlayer = this.currentPlayer + 1 < this.players ? this.currentPlayer+1 : 0; // Switch turns to the next player
    var seed = Math.random();
    self.continueGame = function(_seed){
      // Respond with seed
      if (nosend)
        window.connection.send({seed: seed});

      self.addRandomTile((_seed + seed) / 2);
      if (!self.movesAvailable()) {
        self.over = true; // Game over!

        self.winners = [];
        var highest = Math.max.apply(null, self.scores);
        for (var x = 0; x < self.scores.length; x++) {
          if (self.scores[x] === highest)
            self.winners.push(x);
        }
      }

      self.actuate();
      self.continueGame = null;
    };

    if (!nosend) {
      window.connection.send({move: direction, seed: seed});
    }
  }
};

// Get the vector representing the chosen direction
GameManager.prototype.getVector = function (direction) {
  // Vectors representing tile movement
  var map = {
    0: { x: 0,  y: -1 }, // up
    1: { x: 1,  y: 0 },  // right
    2: { x: 0,  y: 1 },  // down
    3: { x: -1, y: 0 }   // left
  };

  return map[direction];
};

// Build a list of positions to traverse in the right order
GameManager.prototype.buildTraversals = function (vector) {
  var traversals = { x: [], y: [] };

  for (var pos = 0; pos < this.size; pos++) {
    traversals.x.push(pos);
    traversals.y.push(pos);
  }

  // Always traverse from the farthest cell in the chosen direction
  if (vector.x === 1) traversals.x = traversals.x.reverse();
  if (vector.y === 1) traversals.y = traversals.y.reverse();

  return traversals;
};

GameManager.prototype.findFarthestPosition = function (cell, vector) {
  var previous;

  // Progress towards the vector direction until an obstacle is found
  do {
    previous = cell;
    cell     = { x: previous.x + vector.x, y: previous.y + vector.y };
  } while (this.grid.withinBounds(cell) &&
           this.grid.cellAvailable(cell));

  return {
    farthest: previous,
    next: cell // Used to check if a merge is required
  };
};

GameManager.prototype.movesAvailable = function () {
  return this.grid.cellsAvailable() || this.tileMatchesAvailable();
};

// Check for available matches between tiles (more expensive check)
GameManager.prototype.tileMatchesAvailable = function () {
  var self = this;

  var tile;

  for (var x = 0; x < this.size; x++) {
    for (var y = 0; y < this.size; y++) {
      tile = this.grid.cellContent({ x: x, y: y });

      if (tile) {
        for (var direction = 0; direction < 4; direction++) {
          var vector = self.getVector(direction);
          var cell   = { x: x + vector.x, y: y + vector.y };

          var other  = self.grid.cellContent(cell);

          if (other && other.value === tile.value) {
            return true; // These two tiles can be merged
          }
        }
      }
    }
  }

  return false;
};

GameManager.prototype.positionsEqual = function (first, second) {
  return first.x === second.x && first.y === second.y;
};
