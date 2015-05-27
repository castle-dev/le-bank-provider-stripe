'use strict'

var gulp = require('gulp');
var util = require('gulp-util');
var jsdoc = require('gulp-jsdoc');
var clean = require('gulp-clean');
var runSequence = require('run-sequence');
var mocha = require('gulp-mocha');
var cover = require('gulp-coverage');
var bump = require('gulp-bump');
var git = require('gulp-git');
var tag = require('gulp-tag-version');
var rename = require("gulp-rename");

gulp.task('clean', function () {
  return gulp.src(['docs', 'dist'], { read : false })
  .pipe(clean());
})

gulp.task('docs', function () {
  return gulp.src(['README.md', 'src/**/*.js'])
  .pipe(jsdoc('./docs', { path: 'ink-docstrap', theme: 'cyborg' }));
});

gulp.task('test:unit', function () {
  return gulp.src('test/unit/**/*.js', {read: false})
  .pipe(mocha({reporter: 'nyan'}))
  .on('error', util.log);
});

gulp.task('test:e2e', function () {
  return gulp.src('test/e2e/**/*.js', {read: false})
  .pipe(mocha({reporter: 'nyan'}))
  .on('error', util.log);
});

gulp.task('coverage', function () {
  return gulp.src(['test/unit/**/*.js'], { read: false })
  .pipe(cover.instrument({
    pattern: ['src/**/*.js'],
    debugDirectory: 'debug'
  }))
  .pipe(mocha())
  .pipe(cover.gather())
  .pipe(cover.format())
  .pipe(gulp.dest('reports'));
});

function updateVersionNumber(type) {
  return gulp.src(['./package.json'])
  .pipe(bump({type: type}))
  .pipe(gulp.dest('./'))
  .pipe(git.commit('chore(version): ' + type))
  .pipe(tag({prefix: ''}));
}

gulp.task('bump:patch', function() { return updateVersionNumber('patch'); })
gulp.task('bump:minor', function() { return updateVersionNumber('minor'); })
gulp.task('bump:major', function() { return updateVersionNumber('major'); })

gulp.task('watch', function () {
  gulp.watch(['src/**/*.js'], ['test:unit', 'docs']);
  gulp.watch(['test/unit/**/*.js'], ['test:unit']);
  gulp.watch(['test/e2e/**/*.js'], ['test:e2e']);
})

gulp.task('tdd', function (done) {
  runSequence('test:unit', 'watch', done)
});

gulp.task('test', ['test:unit']);
