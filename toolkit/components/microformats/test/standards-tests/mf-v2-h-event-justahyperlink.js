/*
Microformats Test Suite - Downloaded from github repo: microformats/tests version v0.1.24
Mocha integration test from: microformats-v2/h-event/justahyperlink
The test was built on Fri Sep 25 2015 13:26:26 GMT+0100 (BST)
*/

assert = chai.assert;


describe('h-event', function() {
   var htmlFragment = "<a class=\"h-event\" href=\"http://indiewebcamp.com/2012\">IndieWebCamp 2012</a>";
   var expected = {"items":[{"type":["h-event"],"properties":{"name":["IndieWebCamp 2012"],"url":["http://indiewebcamp.com/2012"]}}],"rels":{},"rel-urls":{}};

   it('justahyperlink', function(){
       var doc, dom, node, options, parser, found;
       dom = new DOMParser();
       doc = dom.parseFromString( htmlFragment, 'text/html' );
       options ={
       		'document': doc,
       		'node': doc,
       		'baseUrl': 'http://example.com',
       		'dateFormat': 'html5'
       };
       found = Microformats.get( options );
       assert.deepEqual(found, expected);
   });
});
